export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  auth: {
    enabled: process.env.AUTH_ENABLED === 'true',
    devMode: process.env.AUTH_DEV_MODE === 'true',
    devEmail: process.env.AUTH_DEV_EMAIL,
    signOutUrl: process.env.AUTH_SIGN_OUT_URL || '',
  },
  storage: {
    enabled: process.env.STORAGE_ENABLED === 'true' || true,
    bucket: process.env.ANALYSIS_STORAGE_BUCKET || process.env.SAAS_STORAGE_BUCKET,
    table: process.env.ANALYSIS_METADATA_TABLE,
  },
  aws: {
    region: process.env.AWS_REGION || process.env.CDK_DEPLOY_REGION,
    s3: {
      waDocsBucket: process.env.WA_DOCS_S3_BUCKET || process.env.SAAS_STORAGE_BUCKET,
    },
    bedrock: {
      knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID,
      modelId: process.env.MODEL_ID,
    },
    ddb: {
      lensMetadataTable: process.env.LENS_METADATA_TABLE,
    }    
  },
  // Language configuration for output
  language: {
    output: process.env.OUTPUT_LANGUAGE || 'en', // Default is English
  },
  // Batch size configuration for parallel analysis processing
  analysis: {
    batchSize: parseInt(process.env.BATCH_SIZE, 10) || 5, // Default for WA lens & domain reviews, range 1-12
    smaBatchSize: parseInt(process.env.SMA_BATCH_SIZE, 10) || 3, // Default for SMA (heavier responses), range 1-12
  },
});