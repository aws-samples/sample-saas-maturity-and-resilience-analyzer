import logging
import os

import boto3
from botocore.exceptions import ClientError

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    """
    The new multi-lenses support introduced on 14-April-2025 is a breaking change. This function is meant to support a seamless transition from previous single-lens (wellarchitected) storage structure to the new multi-lens structure.
    Lambda function to migrate storage structure from single-lens to multi-lens format. The Lambda will only run at cdk deployment time once and only for deployments where the old single-lens structure is detected.
    """
    logger.info(f"Starting migration check with event: {event}")

    # Initialize clients
    dynamodb = boto3.client("dynamodb")
    s3 = boto3.client("s3")

    # Get environment variables
    analysis_metadata_table = os.environ.get("ANALYSIS_METADATA_TABLE")
    analysis_storage_bucket = os.environ.get("ANALYSIS_STORAGE_BUCKET")
    wa_docs_bucket = os.environ.get("WA_DOCS_BUCKET_NAME")

    if not all([analysis_metadata_table, analysis_storage_bucket, wa_docs_bucket]):
        logger.error("Missing required environment variables")
        return {"statusCode": 500, "body": "Missing required environment variables"}

    try:
        # Step 1: Scan the DynamoDB table and check if migration is needed
        need_migration = check_migration_needed(dynamodb, analysis_metadata_table)

        if not need_migration:
            logger.info(
                "No migration needed. Either the table is empty or already in multi-lens format."
            )
            # Step 5: Clean up wafrReferenceDocsBucket regardless
            cleanup_wa_docs_bucket(s3, wa_docs_bucket)
            return {"statusCode": 200, "body": "No migration needed"}

        # Step 2: Update DynamoDB items
        logger.info("Migrating DynamoDB items to multi-lens format...")
        update_dynamodb_items(dynamodb, analysis_metadata_table)

        # Step 4: Migrate S3 objects
        logger.info("Migrating S3 objects to multi-lens structure...")
        migrate_s3_objects(s3, analysis_storage_bucket)

        # Step 5: Clean up wafrReferenceDocsBucket
        logger.info("Cleaning up wafrReferenceDocsBucket...")
        cleanup_wa_docs_bucket(s3, wa_docs_bucket)

        return {"statusCode": 200, "body": "Migration completed successfully"}

    except Exception as e:
        logger.error(f"Error during migration: {str(e)}")
        return {"statusCode": 500, "body": f"Migration failed: {str(e)}"}


def check_migration_needed(dynamodb, table_name):
    """
    Checks if migration is needed by scanning the DynamoDB table
    Returns True if migration is needed, False otherwise
    """
    # Scan the table with a small limit first to check structure
    response = dynamodb.scan(TableName=table_name, Limit=20)

    items = response.get("Items", [])

    if not items:
        logger.info("No items found in DynamoDB table. No migration needed.")
        return False

    # Check if any items have the usedLenses attribute (new format)
    for item in items:
        if "usedLenses" in item:
            logger.info(
                "Found items with usedLenses attribute. Table is already in multi-lens format."
            )
            return False

    logger.info("Found items in old format. Migration needed.")
    return True


def update_dynamodb_items(dynamodb, table_name):
    """
    Updates all DynamoDB items to the new multi-lens format
    """
    # Get all items from the table
    items = []
    last_evaluated_key = None

    while True:
        if last_evaluated_key:
            response = dynamodb.scan(
                TableName=table_name, ExclusiveStartKey=last_evaluated_key
            )
        else:
            response = dynamodb.scan(TableName=table_name)

        items.extend(response.get("Items", []))
        last_evaluated_key = response.get("LastEvaluatedKey")

        if not last_evaluated_key:
            break

    logger.info(f"Found {len(items)} items to migrate in DynamoDB")

    # Update each item
    for item in items:
        user_id = item["userId"]
        file_id = item["fileId"]

        # Prepare the update expression
        update_expression = "SET "
        expression_attribute_values = {}
        expression_attribute_names = {}

        # Add usedLenses attribute
        update_expression += "#usedLenses = :usedLenses, "
        expression_attribute_names["#usedLenses"] = "usedLenses"
        expression_attribute_values[":usedLenses"] = {
            "L": [
                {
                    "M": {
                        "lensAlias": {"S": "wellarchitected"},
                        "lensName": {"S": "Well-Architected Framework"},
                        "lensAliasArn": {
                            "S": "arn:aws:wellarchitected::aws:lens/wellarchitected"
                        },
                    }
                }
            ]
        }

        # Convert single values to maps with wellarchitected key
        attributes_to_convert = [
            "analysisStatus",
            "analysisProgress",
            "analysisError",
            "analysisPartialResults",
            "iacGenerationStatus",
            "iacGenerationProgress",
            "iacGenerationError",
            "iacGeneratedFileType",
            "iacPartialResults",
            "supportingDocumentAdded",
            "supportingDocumentDescription",
            "supportingDocumentId",
            "supportingDocumentName",
            "supportingDocumentType",
        ]

        for attr in attributes_to_convert:
            if attr in item:
                update_expression += f"#{attr} = :{attr}, "
                expression_attribute_names[f"#{attr}"] = attr

                # Different handling based on attribute type
                if "N" in item[attr]:  # Number
                    expression_attribute_values[f":{attr}"] = {
                        "M": {"wellarchitected": {"N": item[attr]["N"]}}
                    }
                elif "S" in item[attr]:  # String
                    expression_attribute_values[f":{attr}"] = {
                        "M": {"wellarchitected": {"S": item[attr]["S"]}}
                    }
                elif "BOOL" in item[attr]:  # Boolean
                    expression_attribute_values[f":{attr}"] = {
                        "M": {"wellarchitected": {"BOOL": item[attr]["BOOL"]}}
                    }

        # Add workloadIds if there is a workloadId
        if "workloadId" in item:
            update_expression += "#workloadIds = :workloadIds, "
            expression_attribute_names["#workloadIds"] = "workloadIds"
            expression_attribute_values[":workloadIds"] = {
                "M": {
                    "wellarchitected": {
                        "M": {
                            "id": {"S": item["workloadId"]["S"]},
                            "protected": {"BOOL": True},
                        }
                    }
                }
            }

            # Remove workloadId
            update_expression += "REMOVE workloadId"
        else:
            # Remove trailing comma and space
            update_expression = update_expression[:-2]

        try:
            # Update the item
            dynamodb.update_item(
                TableName=table_name,
                Key={"userId": user_id, "fileId": file_id},
                UpdateExpression=update_expression,
                ExpressionAttributeNames=expression_attribute_names,
                ExpressionAttributeValues=expression_attribute_values,
            )
            logger.info(
                f"Updated item for userId={user_id['S']}, fileId={file_id['S']}"
            )
        except Exception as e:
            logger.error(
                f"Error updating item for userId={user_id['S']}, fileId={file_id['S']}: {str(e)}"
            )


def migrate_s3_objects(s3, bucket_name):
    """
    Migrates S3 objects from the old structure to the new multi-lens structure
    """
    # List all objects in the bucket
    all_objects = []
    continuation_token = None

    while True:
        if continuation_token:
            response = s3.list_objects_v2(
                Bucket=bucket_name, ContinuationToken=continuation_token
            )
        else:
            response = s3.list_objects_v2(Bucket=bucket_name)

        if "Contents" in response:
            all_objects.extend(response.get("Contents", []))

        if not response.get("IsTruncated"):
            break
        continuation_token = response.get("NextContinuationToken")

    logger.info(f"Found {len(all_objects)} objects in S3 bucket {bucket_name}")

    # Group objects by userId/fileId
    grouped_objects = {}
    for obj in all_objects:
        key = obj["Key"]
        parts = key.split("/")

        # Only process objects with at least userId/fileId structure
        if len(parts) >= 2:
            user_id = parts[0]
            file_id = parts[1]
            group_key = f"{user_id}/{file_id}"

            if group_key not in grouped_objects:
                grouped_objects[group_key] = []

            grouped_objects[group_key].append(obj)

    # Process each group
    for prefix, objects in grouped_objects.items():
        # Find objects that need to be migrated
        analysis_results = None
        iac_templates = None
        supporting_docs = []

        for obj in objects:
            key = obj["Key"]

            # Check for old structure paths
            if key.endswith("/analysis/analysis_results.json"):
                analysis_results = obj
            elif (
                "/iac_templates/generated_template." in key
                and "/iac_templates/wellarchitected/" not in key
            ):
                iac_templates = obj
            elif (
                "/supporting_documents/" in key
                and "/supporting_documents/wellarchitected/" not in key
            ):
                # Check if this is not a metadata file and is directly under supporting_documents/
                parts = key.split("/")
                if len(parts) >= 4 and parts[-2] == "supporting_documents":
                    supporting_docs.append(obj)

        # Migrate analysis results
        if analysis_results:
            old_key = analysis_results["Key"]
            new_key = old_key.replace(
                "/analysis/analysis_results.json",
                "/analysis/wellarchitected/analysis_results.json",
            )
            logger.info(f"Migrating analysis results: {old_key} -> {new_key}")

            try:
                # Copy to new location
                s3.copy_object(
                    Bucket=bucket_name,
                    CopySource={"Bucket": bucket_name, "Key": old_key},
                    Key=new_key,
                )

                # Delete old object
                s3.delete_object(Bucket=bucket_name, Key=old_key)
                logger.info(f"Successfully migrated analysis results: {old_key}")
            except Exception as e:
                logger.error(f"Error migrating analysis results {old_key}: {str(e)}")

        # Migrate IaC templates
        if iac_templates:
            old_key = iac_templates["Key"]
            # Extract the extension
            if ".generated_template." in old_key:
                ext = old_key.split(".generated_template.")[1]
                new_key = old_key.replace(
                    f".generated_template.{ext}",
                    f".wellarchitected/generated_template.{ext}",
                )
            else:
                ext = old_key.split("generated_template.")[1]
                new_key = old_key.replace(
                    f"/iac_templates/generated_template.{ext}",
                    f"/iac_templates/wellarchitected/generated_template.{ext}",
                )

            logger.info(f"Migrating IaC template: {old_key} -> {new_key}")

            try:
                # Copy to new location
                s3.copy_object(
                    Bucket=bucket_name,
                    CopySource={"Bucket": bucket_name, "Key": old_key},
                    Key=new_key,
                )

                # Delete old object
                s3.delete_object(Bucket=bucket_name, Key=old_key)
                logger.info(f"Successfully migrated IaC template: {old_key}")
            except Exception as e:
                logger.error(f"Error migrating IaC template {old_key}: {str(e)}")

        # Migrate supporting documents
        for doc in supporting_docs:
            old_key = doc["Key"]
            # Extract doc ID from the path
            parts = old_key.split("/")
            if len(parts) >= 4:
                doc_id = parts[-1]
                new_key = old_key.replace(
                    f"/supporting_documents/{doc_id}",
                    f"/supporting_documents/wellarchitected/{doc_id}",
                )
                logger.info(f"Migrating supporting document: {old_key} -> {new_key}")

                try:
                    # Copy to new location
                    s3.copy_object(
                        Bucket=bucket_name,
                        CopySource={"Bucket": bucket_name, "Key": old_key},
                        Key=new_key,
                    )

                    # Delete old object
                    s3.delete_object(Bucket=bucket_name, Key=old_key)
                    logger.info(f"Successfully migrated supporting document: {old_key}")
                except Exception as e:
                    logger.error(
                        f"Error migrating supporting document {old_key}: {str(e)}"
                    )


def cleanup_wa_docs_bucket(s3, bucket_name):
    """
    Removes old files from the root of the wafrReferenceDocsBucket
    """
    files_to_delete = [
        "well_architected_best_practices.csv",
        "well_architected_best_practices.json",
        "wellarchitected-cost-optimization-pillar.pdf",
        "wellarchitected-operational-excellence-pillar.pdf",
        "wellarchitected-performance-efficiency-pillar.pdf",
        "wellarchitected-reliability-pillar.pdf",
        "wellarchitected-security-pillar.pdf",
        "wellarchitected-sustainability-pillar.pdf",
    ]

    # Check if files exist before deleting
    for file_name in files_to_delete:
        try:
            # Check if file exists
            s3.head_object(Bucket=bucket_name, Key=file_name)

            # If no exception, file exists - delete it
            logger.info(f"Deleting {file_name} from {bucket_name}")
            s3.delete_object(Bucket=bucket_name, Key=file_name)
        except ClientError as e:
            if e.response["Error"]["Code"] == "404":
                logger.info(
                    f"File {file_name} not found in bucket {bucket_name}, skipping"
                )
            else:
                logger.error(f"Error checking/deleting file {file_name}: {str(e)}")
