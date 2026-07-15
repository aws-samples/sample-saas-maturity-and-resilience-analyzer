"""
Lambda that locks down the OpenSearch Serverless network policy after
the VectorIndex custom resource has been created.

On CREATE/UPDATE: switches the network policy from AllowFromPublic to
VPC-endpoint-only + Bedrock service access.

On DELETE: reverts the network policy to AllowFromPublic so the
VectorIndex cleanup Lambda (which runs outside the VPC) can reach
OpenSearch to delete the index.

This Lambda is invoked by a CDK cr.Provider-backed custom resource.
The Provider framework handles CloudFormation callbacks; this handler
just needs to return successfully or raise an exception.
"""

import json
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

client = boto3.client("opensearchserverless")


def handler(event, context):
    logger.info("Event: %s", json.dumps(event))
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    policy_name = props["PolicyName"]
    collection_name = props["CollectionName"]
    vpce_id = props["VpcEndpointId"]

    if request_type in ("Create", "Update"):
        _lock_down(policy_name, collection_name, vpce_id)
    elif request_type == "Delete":
        _revert_to_public(policy_name, collection_name)

    return {"PhysicalResourceId": f"lockdown-{policy_name}"}


def _get_policy(policy_name):
    """Retrieve the current network policy and its version."""
    resp = client.get_security_policy(name=policy_name, type="network")
    detail = resp["securityPolicyDetail"]
    return detail["policy"], detail["policyVersion"]


def _lock_down(policy_name, collection_name, vpce_id):
    """Replace AllowFromPublic with VPC endpoint + Bedrock service access."""
    current_policy, version = _get_policy(policy_name)
    logger.info("Current policy (version %s): %s", version, json.dumps(current_policy))

    new_policy = []
    for rule in current_policy:
        new_rule = dict(rule)
        # Replace the source config: remove AllowFromPublic, add VPCE + Bedrock
        new_rule.pop("AllowFromPublic", None)
        new_rule["SourceVPCEs"] = [vpce_id]
        new_rule["SourceServices"] = ["bedrock.amazonaws.com"]
        new_policy.append(new_rule)

    logger.info("New policy: %s", json.dumps(new_policy))

    client.update_security_policy(
        name=policy_name,
        type="network",
        policyVersion=version,
        policy=json.dumps(new_policy),
    )
    logger.info("Network policy locked down successfully")


def _revert_to_public(policy_name, collection_name):
    """Revert to AllowFromPublic so VectorIndex cleanup Lambda can work."""
    try:
        current_policy, version = _get_policy(policy_name)
    except client.exceptions.ResourceNotFoundException:
        logger.info("Policy %s not found, nothing to revert", policy_name)
        return

    logger.info("Reverting policy (version %s): %s", version, json.dumps(current_policy))

    new_policy = []
    for rule in current_policy:
        new_rule = dict(rule)
        # Remove VPC-specific fields, restore public access
        new_rule.pop("SourceVPCEs", None)
        new_rule.pop("SourceServices", None)
        new_rule["AllowFromPublic"] = True
        new_policy.append(new_rule)

    logger.info("Reverted policy: %s", json.dumps(new_policy))

    client.update_security_policy(
        name=policy_name,
        type="network",
        policyVersion=version,
        policy=json.dumps(new_policy),
    )
    logger.info("Network policy reverted to public access")
