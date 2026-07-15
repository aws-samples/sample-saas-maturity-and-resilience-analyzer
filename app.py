#!/usr/bin/env python3
import os

import aws_cdk as cdk

from ecs_fargate_app.resilience_analyzer_stack import ResilienceAnalyzerStack

app = cdk.App()

# Try to get the region from an environment variable
REGION = os.environ.get("CDK_DEPLOY_REGION")

# If REGION is still None, it will use the default region when deployed
env = cdk.Environment(region=REGION) if REGION else None

APP_PREFIX = f"Resilience-Analyzer-{REGION or 'default'}"

# Create the Resilience Analyzer Stack
resilience_analyzer_stack = ResilienceAnalyzerStack(
    app,
    f"{APP_PREFIX}-Stack",
    env=env,
)

app.synth()
