import * as blueprints from "@aws-quickstart/eks-blueprints";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {
  getSecretValue,
  validateSecret,
} from "@aws-quickstart/eks-blueprints/dist/utils/secrets-manager-utils";
import * as cdk from "aws-cdk-lib";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import {
  getGithubRepoConfig,
  toolsRegion
} from "./config/environments";
import * as clusterConfig from "./config/cluster";
import { gen3ClusterProvider } from "./config/cluster/cluster-provider";
import { buildPolicyStatements } from "./iam";
import { IamRolesStack } from "./iam-roles-stack";
import {
  getStages,
  validateParameter,
  getAwsConfig,
  addCredentialsOrConnectionArn,
} from "./config/environments";
import {
  EnvironmentConfig,
  Config,
  RepoConfig,
} from "./config/environments/config-interfaces";
import { Gen3ConfigEventsStack } from "./gen3-config-events-stack";
import { OidcIssuerStack } from "./oidc-issuer-stack";
import { OidcIssuerAddOn } from "./oidc-issuer-addon";
import { IamRolesAddOn } from "./iam-roles-addon";


export class Gen3EksPipelineStack extends cdk.Stack {
  async buildAsync(scope: Construct, id: string, props: cdk.StackProps) {
    const pipelineName = `${id}`; //pipeline builder name

    //Validate required parameters
    validateParameter("/gen3/config", toolsRegion)
    validateParameter("/gen3/eks-blueprint-repo", toolsRegion)

    // We need region to read the initial configuration
    const envValuesString = await getAwsConfig("/gen3/config", toolsRegion);
    const envValues: Config = envValuesString ? JSON.parse(envValuesString) : null;

    const env = props.env;

    if (!env?.region || !env?.account) {
      throw new Error("Both region and account are required.");
    }

    const region = env.region;
    const account = env.account;

    // Github credentials for this repo
    const eksPipelineRepoFromParameterStore = await getGithubRepoConfig(region);

    let repositoryConfig: RepoConfig = {
      gitRepoOwner: eksPipelineRepoFromParameterStore.gitRepoOwner,
      repoUrl: eksPipelineRepoFromParameterStore.repoUrl,
      targetRevision: eksPipelineRepoFromParameterStore.targetRevision,
      credentialsSecretName: "github-token",
    };

    let codeStarConnectionArn = "";

    try {
      codeStarConnectionArn = await getSecretValue(
        "code-star-connection-arn",
        "ap-southeast-2"
      );
      repositoryConfig = addCredentialsOrConnectionArn(
        eksPipelineRepoFromParameterStore,
        {
          codeStarConnectionArn,
        }
      );
    } catch (error) {
      console.log(
        `Warning: Secret name, code-star-connection-arn not found in secret manager, region: ${error}.`
      );
      console.log("** Warning: Will try github-token");
    }

    if (!codeStarConnectionArn) {
      try {
        validateSecret("github-token", region);
        repositoryConfig = addCredentialsOrConnectionArn(
          eksPipelineRepoFromParameterStore,
          {
            credentialsSecretName: "github-token",
          }
        );
      } catch (error) {
        console.log(
          "** Error: Could not find any required credentials for github in secrets manager"
        );
        throw error;
      }
    }

    blueprints.HelmAddOn.validateHelmVersions = true;
    blueprints.HelmAddOn.failOnVersionValidation = false;
    blueprints.utils.logger.settings.minLevel = 3; // info
    blueprints.utils.userLog.settings.minLevel = 2; // debug

    const addOns: Array<blueprints.ClusterAddOn> = [
      new blueprints.addons.AwsLoadBalancerControllerAddOn({
        enableWafv2: true,
      }),
      ...clusterConfig.commonAddons,
    ];

    const blueprint = blueprints.EksBlueprint.builder()
      .name(pipelineName)
      .account(account)
      .region(region)
      .addOns(...addOns);

    // Gen3 environment stages
    const stages = await getStages(toolsRegion);

    console.log(stages)

    // Create the CodePipelineStack
    const pipelineStack = blueprints.CodePipelineStack.builder()
      .name(`gen3-eks-${envValues.tools.name}`)
      .owner(repositoryConfig.gitRepoOwner)
      .codeBuildPolicies(buildPolicyStatements)
      .repository(repositoryConfig)
      .enableCrossAccountKeys();

    // Add stages dynamically
    for (const { id, env, teams, externalSecret, addons } of stages) {

      // new ssm.StringParameter(this, `${env.name}-gen3Hostname`, {
      //   parameterName: `/gen3/${env.project || env.name} /${env.name}/hostname`,
      //   stringValue: env.hostname || 'gen3 hostname',
      // });

      const issuerAddon = new OidcIssuerAddOn(
        env.namespace,
        `/gen3/${env.namespace}-${env.name}/oidcIssuer`,
        env.aws
      );
      const stageBuilder = blueprint
        .clone(region)
        .name(env.clusterName)
        .addOns(
          ...addons,
          issuerAddon,
          new IamRolesAddOn(env.name, env.namespace)
        )
        .clusterProvider(
          // We check if env.clusterSubnets and env.nodeGroupSubnets are defined.
          // If they are, it calls this.subnetsSelection to create a subnet selection;
          // otherwise, it passes undefined to gen3ClusterProvider
          await gen3ClusterProvider(
            env.name,
            env.clusterName,
            env.clusterSubnets
              ? this.subnetsSelection(env.clusterSubnets, "cluster")
              : undefined,
            env.nodeGroupSubnets
              ? this.subnetsSelection(env.nodeGroupSubnets, "nodes")
              : undefined
          )
        )
        .resourceProvider(
          blueprints.GlobalResources.Vpc,
          new blueprints.VpcProvider(env.vpcId || undefined)
        )
        .withEnv(env.aws);

      // Conditionally add teams only if platformRoleName is defined
      if (teams) {
        stageBuilder.teams(...teams, externalSecret);
      } else {
        stageBuilder.teams(externalSecret);
      }

      pipelineStack.stage({
        id: id,
        stackBuilder: stageBuilder,
        stageProps: {
          pre: [
            new blueprints.pipelines.cdkpipelines.ManualApprovalStep(
              "manual-approval"
            ),
          ],
        },
      });
    }

    pipelineStack.build(scope, `${id}-stack`, { env: envValues.tools.aws });


    // Event Bus stacks for each each environment
    // account is the source (tools) account here
    this.addEventBusStack(scope, envValues);
  }

  private subnetsSelection(subnetIds: string[], type: string) {
    const subnetsSelection: ec2.SubnetSelection = {
      subnets: subnetIds.map((subnetId) =>
        ec2.Subnet.fromSubnetId(this, `Subnet-${subnetId}-${type}`, subnetId)
      ),
    };
    return subnetsSelection;
  }


  private addEventBusStack(scope: Construct, envConfigs: Config) {
    new Gen3ConfigEventsStack(scope, `gen3-eventBus-stack`, {
      env: { region: toolsRegion, account: this.account },
      envConfigs,
    });
  }
}
