#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";
import { Gen3EksPipelineStack } from "../lib/gen3-eks-pipeline-stack";
import { Gen3EksBlueprintsStack } from "../lib/gen3-eks-blueprints-stack";
import { loadEnvConfig, loadClusterConfig } from "../lib/loadConfig";

const app = new cdk.App();

// Automatically detect if running in a CI/CD pipeline
const isPipelineEnv =
  process.env.CODEBUILD_BUILD_ID ||
  process.env.GITHUB_ACTIONS || 
  process.env.CI;

// Default to pipeline mode if in a CI/CD environment
const usePipeline = isPipelineEnv || app.node.tryGetContext("usePipeline") === "true";

if (usePipeline) {
  const props = {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    envName: "tools",
    project: "OMIX3",
  };
  console.log(`🚀 Deploying EKS with CI/CD Pipeline...`);
  new Gen3EksPipelineStack().buildAsync(app, `Gen3-Eks-pipeline`, props);
} else {
  // Get environment from context or default to "uat"
  const envName = app.node.tryGetContext("envName") || "uat";
  const envConfig = loadEnvConfig(envName);
  const clusterConfig = loadClusterConfig(envName);

  const props = {
    env: {
      account: envConfig.aws.account,
      region: envConfig.aws.region,
    },
    envName,
    project: "OMIX3",
  };
  console.log(`🚀 Deploying EKS without Pipeline for environment: ${envName}...`);
  new Gen3EksBlueprintsStack(app, `Gen3-Eks-Blueprint-${envName}`, props);
}