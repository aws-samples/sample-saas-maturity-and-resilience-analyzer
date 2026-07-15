# High-Level Interactions: IaC Template Upload → SaaS Resilience Analysis → Bedrock RAG → Results

## Overview
This document explains the complete flow from when an Infrastructure as Code (IaC) template is uploaded, through SaaS Resilience analysis, to Bedrock prompting with RAG (Retrieval-Augmented Generation), and finally to results display.

---

## 1. Template Upload & Storage

**Frontend (React + AWS Cloudscape)**
- User uploads IaC template (CloudFormation/Terraform/CDK) or architecture diagram via web UI
- User selects analysis domain: "SaaS Resilience" (`selectedDomain: 'saas_resilience'`)

**Backend Controller** (`analyzer.controller.ts`)
- Receives POST request at `/analyzer/analyze` endpoint
- Extracts user authentication info from headers
- Validates request parameters

**Storage Service** (`storage.service.ts`)
- Stores original file in S3 bucket (`analysis_storage_bucket`)
- Creates metadata entry in DynamoDB (`analysis_metadata_table`)
- Generates unique `fileId` and `userId` hash

---

## 2. Analysis Initialization

**Analyzer Service** (`analyzer.service.ts` → `analyze()` method)

```typescript
// Key steps:
1. Retrieve file content from S3 storage
2. Get domain configuration for SaaS Resilience
3. Load SaaS Resilience questions (from S3 or config fallback)
4. Update work item status to 'IN_PROGRESS' for saas_resilience domain
5. Begin iterating through each question
```

**Domain Configuration**
- Loads SaaS Resilience Lens questions from `domain.config.ts` or S3
- Each question contains:
  - `pillar`: e.g., "Reliability", "Performance", "Security"
  - `title`: e.g., "How do you design your workload to withstand component failures?"
  - `bestPractices`: List of specific practices to evaluate

---

## 3. RAG (Retrieval-Augmented Generation) - Knowledge Base Query

**For each question, the system performs RAG via `retrieveFromKnowledgeBase()`:**

### Knowledge Base Query Construction

```typescript
const command = new RetrieveAndGenerateCommand({
  input: {
    text: buildKnowledgeBaseInputPrompt(
      question, 
      pillar, 
      domainQuestion, 
      "SaaS Resilience"
    )
  },
  retrieveAndGenerateConfiguration: {
    type: "KNOWLEDGE_BASE",
    knowledgeBaseConfiguration: {
      knowledgeBaseId: KB_ID,
      modelArn: modelId,
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 10,
          filter: {
            andAll: [
              { equals: { key: "domain_name", value: "SaaS Resilience" } },
              { equals: { key: "pillar", value: pillar } }
            ]
          }
        }
      }
    }
  }
});
```

### What Happens in RAG:

1. **Query Construction** (`knowledge-base-prompts.ts`)
   - Builds input prompt asking for best practice details
   - Includes: risk levels, implementation guidance, anti-patterns

2. **Vector Search**
   - Bedrock Knowledge Base uses **Titan Text Embeddings V2**
   - Searches vector database of Well-Architected documentation
   - Filters by domain ("SaaS Resilience") and pillar

3. **Document Retrieval**
   - Returns top 10 relevant document chunks
   - Sources from Well-Architected SaaS Resilience Lens whitepapers
   - Includes metadata: pillar, domain, best practice IDs

4. **Context Generation**
   - Retrieved chunks become `kbContexts` array
   - Contains detailed guidance for each best practice
   - Includes Technical Relevancy scores (1-10)

---

## 4. Bedrock Analysis with Claude

**The system calls `analyzeQuestion()` which invokes Claude via Bedrock:**

### Prompt Construction

```typescript
// 1. Build user prompt with question and KB context
const prompt = buildPrompt(question, kbContexts, supportingDocName, supportingDocDescription);

// 2. Build system prompt with template content and instructions
const systemPrompt = buildSystemPrompt(
  fileContent, 
  question, 
  "SaaS Resilience", 
  pillarNames,
  {},
  outputLanguage
);

// 3. Send to Claude via Converse API
const command = new ConverseCommand({
  modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",  // or Claude 3.7
  messages: [
    { 
      role: "user", 
      content: [{ text: prompt }] 
    }
  ],
  system: [{ text: systemPrompt }],
  inferenceConfig: { 
    maxTokens: 8192, 
    temperature: 0.7 
  }
});

const response = await bedrockClient.send(command);
```

### Prompt Structure Components

**System Prompt** (`system-prompts.ts`):
```
<role>
You are an AWS Cloud Solutions Architect specializing in reviewing 
against AWS Well-Architected SaaS Resilience Lens
</role>

<context>
- Template content: [IaC code]
- Domain: SaaS Resilience
- Pillars: Reliability, Performance, Security, etc.
- Output language: [English/Japanese/Spanish/Portuguese]
</context>

<instructions>
1. Evaluate each best practice for relevance (Technical Relevancy score ≥ 7)
2. Determine if applied in the template
3. Provide reasoning and recommendations
4. Return JSON response with specific format
</instructions>

<note_on_relevance>
- Mark relevant=true only if Technical Relevancy score ≥ 7
- Must relate to AWS resources, configurations, or architecture
- Must be assessable from the IaC template
</note_on_relevance>
```

**User Prompt** (`analysis-prompts.ts`):
```xml
<best_practices_json>
{
  "pillar": "Reliability",
  "question": "How do you design your workload to withstand component failures?",
  "bestPractices": [
    "Implement health checks",
    "Use multi-AZ deployments",
    "Configure auto-scaling"
  ]
}
</best_practices_json>

<kb>
[RAG-retrieved documentation about each best practice]
- Implementation guidance
- Risk levels
- Anti-patterns
- Technical Relevancy scores
</kb>

<supporting_document>
[Optional: Additional context from user-provided PDFs/diagrams]
</supporting_document>
```

### Claude's Analysis Task

For each best practice, Claude must:

1. **Determine Relevance**
   - Check Technical Relevancy score from KB context
   - Score ≥ 7: Mark as `relevant: true`
   - Score < 7: Mark as `relevant: false` (organizational/process-focused)

2. **Assess Application** (if relevant)
   - Analyze IaC template code
   - Check for implementation evidence
   - Consider supporting documents if provided

3. **Generate Response**
   ```json
   {
     "bestPractices": [
       {
         "name": "Implement health checks",
         "relevant": true,
         "applied": true,
         "reasonApplied": "The template configures ALB health checks on port 80..."
       },
       {
         "name": "Use multi-AZ deployments",
         "relevant": true,
         "applied": false,
         "reasonNotApplied": "The RDS instance uses single-AZ configuration...",
         "recommendations": "Modify the RDS resource to enable Multi-AZ..."
       }
     ]
   }
   ```

---

## 5. Response Processing

**Back in `analyzer.service.ts`:**

```typescript
// Parse Claude's JSON response
const response = await bedrockClient.send(command);
const responseText = response.output.message.content.find(c => c.text)?.text;

// Clean and parse JSON
const cleanedJson = cleanJsonString(responseText);
const modelResponse = JSON.parse(cleanedJson);

// Structure the analysis result
const analysis = {
  pillar: question.pillar,
  question: question.title,
  questionId: question.id,
  bestPractices: parseModelResponse(modelResponse, question)
};

results.push(analysis);
```

**For each best practice, extracts:**
- `name`: Best practice name (exact match from question)
- `relevant`: Boolean - can it be assessed from template?
- `applied`: Boolean - is it implemented? (only if relevant)
- `reasonApplied`: Explanation of implementation (max 100 words)
- `reasonNotApplied`: Why it's missing (max 100 words)
- `recommendations`: How to implement (max 400 words, only if not applied)

---

## 6. Progress Updates & Storage

### Real-Time Progress

**WebSocket Gateway** (`analyzer.gateway.ts`):
```typescript
// Emits progress to frontend via WebSocket
this.analyzerGateway.emitAnalysisProgress({
  processedQuestions: 5,
  totalQuestions: 20,
  currentPillar: "Reliability",
  currentQuestion: "How do you design for failure?"
});
```

### Incremental Storage

**After each question:**
```typescript
// Update DynamoDB with progress
await storageService.updateWorkItem(userId, fileId, {
  analysisProgress: { 
    saas_resilience: 25  // 5/20 questions = 25%
  },
  lastModified: new Date().toISOString()
});
```

**After all questions complete:**
```typescript
// Store final results in S3
await storageService.storeAnalysisResults(
  userId,
  fileId,
  results,
  'saas_resilience'  // Domain key
);

// Update final status in DynamoDB
await storageService.updateWorkItem(userId, fileId, {
  analysisStatus: { saas_resilience: 'COMPLETED' },
  analysisProgress: { saas_resilience: 100 },
  usedLenses: [
    {
      lensAlias: 'saas_resilience',
      lensName: 'SaaS Resilience',
      lensAliasArn: 'saas_resilience'
    }
  ]
});
```

---

## 7. Results Display & User Actions

### Frontend Display

**Results organized by:**
- **Pillar** (e.g., Reliability, Performance, Security)
  - **Question** (e.g., "How do you design for failure?")
    - **Best Practices**
      - ✅ Applied (with reasoning)
      - ❌ Not Applied (with recommendations)
      - ⊘ Not Relevant (organizational/process)

### Available User Actions

1. **View Detailed Analysis**
   - Click "Get More Details" on specific best practices
   - Triggers another Bedrock call with focused prompt
   - Returns expanded recommendations and examples

2. **Chat with AI Assistant**
   - Ask questions about analysis results
   - Uses stored analysis + original template as context
   - Maintains conversation history in DynamoDB

3. **Export to Well-Architected Tool**
   - Creates workload in AWS Well-Architected Tool
   - Maps analysis results to WAFR questions
   - Updates answers and creates milestone

4. **Generate Improved IaC Template**
   - For architecture diagrams only
   - Uses recommendations to generate CloudFormation/Terraform
   - Iterative generation with progress updates

5. **Multi-Lens Analysis**
   - Analyze same template against different lenses
   - Results stored separately per domain
   - Compare across lenses

---

## Key Infrastructure Components

### CDK Stack (`resilience_analyzer_stack.py`)

**Bedrock Knowledge Base:**
- Embeddings: Titan Text Embeddings V2 (1024 dimensions)
- Chunking: Hierarchical (parent: 2000 tokens, child: 800 tokens)
- Data source: S3 bucket with Well-Architected whitepapers
- Metadata filters: domain_name, pillar, lens_alias

**S3 Buckets:**
- `wafrReferenceDocsBucket`: Source documents for Knowledge Base
- `analysis_storage_bucket`: User uploads, analysis results, chat history

**DynamoDB Tables:**
- `analysis_metadata_table`: Work items, status, progress, workload IDs
  - Partition key: `userId`
  - Sort key: `fileId`
- `lens_metadata_table`: Lens information, questions, best practices
  - Partition key: `lensAlias`

**ECS Fargate Services:**
- Frontend: React app (port 8080)
- Backend: NestJS API (port 3000)
- Service discovery: Private DNS namespace

**Lambda Functions:**
- `kb_lambda_synchronizer`: Weekly sync of KB with latest docs
- `migration_lambda`: One-time migration for multi-lens support
- `stack_cleanup_lambda`: Auto-cleanup for deployment stacks

**Application Load Balancer:**
- Optional authentication (Cognito/OIDC)
- HTTPS with ACM certificate
- Idle timeout: 60 minutes (for long-running analysis)

---

## Flow Characteristics

### Asynchronous Processing
- Analysis runs in background
- Real-time progress via WebSocket
- Frontend remains responsive

### Error Handling
- Partial results saved on errors
- Analysis can be cancelled mid-flight
- Graceful degradation (KB query failures)

### Multi-Lens Support
- Same template analyzed against multiple lenses
- Results stored separately per domain
- Domain-specific status tracking

### Scalability
- Stateless backend (ECS Fargate)
- S3 for file storage
- DynamoDB for metadata
- Bedrock handles AI workload

### Security
- Optional authentication (Cognito/OIDC)
- User data isolation via userId hash
- IAM roles with least privilege
- Encryption at rest and in transit

---

## Example End-to-End Timeline

```
T+0s:    User uploads CloudFormation template, selects "SaaS Resilience"
T+1s:    File stored in S3, metadata in DynamoDB
T+2s:    Analysis starts, loads 20 SaaS Resilience questions
T+3s:    Question 1: RAG query to Knowledge Base (10 docs retrieved)
T+5s:    Question 1: Claude analyzes template (5 best practices evaluated)
T+6s:    Progress: 5% (1/20 questions) - WebSocket update to frontend
T+8s:    Question 2: RAG query...
...
T+120s:  All 20 questions complete
T+121s:  Final results stored in S3
T+122s:  DynamoDB updated: status='COMPLETED', progress=100%
T+123s:  Frontend displays full analysis with recommendations
```

---

## Related Files

- **Backend Service**: `ecs_fargate_app/backend/src/modules/analyzer/analyzer.service.ts`
- **Controller**: `ecs_fargate_app/backend/src/modules/analyzer/analyzer.controller.ts`
- **Prompts**: `ecs_fargate_app/backend/src/prompts/`
- **CDK Stack**: `ecs_fargate_app/resilience_analyzer_stack.py`
- **Domain Config**: `ecs_fargate_app/backend/src/config/domain.config.ts`
- **Storage Service**: `ecs_fargate_app/backend/src/modules/storage/storage.service.ts`
