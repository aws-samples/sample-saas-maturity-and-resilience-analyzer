#!/usr/bin/env python3
import os

import aws_cdk as cdk
from kb_storage_stack import KBStorageStack

app = cdk.App()

# Get the region from environment variable or allow it to use default region
region = os.environ.get("CDK_DEPLOY_REGION")
env = cdk.Environment(region=region) if region else None

# Get the deploy_storage parameter from context or use default (true)
deploy_storage = app.node.try_get_context("deploy_storage")
if deploy_storage is None:
    deploy_storage = "true"

# Define stack name with region suffix for better identification
stack_name = f"dev-wa-iac-analyzer-kb-storage-{region or 'default'}"

KBStorageStack(
    app,
    stack_name,
    env=env,
    stack_name=stack_name,
)

app.synth()
