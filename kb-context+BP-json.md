# KB Context vs Best Practices JSON: Key Differences

## Overview
Understanding the distinction between KB Context and Best Practices JSON is crucial to understanding how the Well-Architected IaC Analyzer performs its analysis using Claude and Bedrock.

---

## **Best Practices JSON** - "What to evaluate"

This is a **structured list** that tells Claude **which specific best practices** to assess in the IaC template.

### Source
Comes from the domain configuration (e.g., `domain.config.ts` or S3)

### Example
```json
{
  "pillar": "Reliability",
  "question": "How do you design your workload to withstand component failures?",
  "bestPractices": [
    "Implement health checks",
    "Use multi-AZ deployments",
    "Configure auto-scaling",
    "Implement circuit breakers"
  ]
}
```

### Purpose
- Defines the **checklist** of items Claude must evaluate
- Ensures Claude evaluates **all** best practices (doesn't skip any)
- Provides the exact names to use in the response
- Typically 3-8 best practices per question

### Characteristics
- **Small**: Usually 3-8 items
- **Structured**: JSON format
- **Static**: Fixed per lens/domain
- **Prescriptive**: Tells Claude exactly what to check

---

## **KB Context** - "How to evaluate it"

This is **detailed documentation** retrieved from the Bedrock Knowledge Base that explains **how to assess** each best practice.

### Source
Retrieved via RAG (Retrieval-Augmented Generation) from Well-Architected whitepapers stored in the Bedrock Knowledge Base

### Example
```markdown
## REL01-BP01: Implement health checks

**Risk Level**: High

**Implementation Guidance**:
- Configure health checks at multiple layers (application, load balancer, container)
- Use deep health checks that verify critical dependencies
- Set appropriate timeout and interval values
- Monitor health check metrics in CloudWatch
- Implement graceful degradation when dependencies are unhealthy

**Common anti-patterns**:
- Using only TCP health checks without verifying application functionality
- Setting health check intervals too long, delaying failure detection
- Not monitoring health check failures
- Failing to test health check behavior under load

**Relationship**: This best practice directly relates to AWS resources like 
Application Load Balancers, Target Groups, ECS task definitions, and Auto 
Scaling Groups.

**Technical Relevancy score:** 9

---

## REL01-BP02: Use multi-AZ deployments

**Risk Level**: High

**Implementation Guidance**:
- Deploy resources across multiple Availability Zones
- Use AWS services that automatically replicate across AZs (RDS Multi-AZ, ELB, etc.)
- Ensure application can handle AZ failures gracefully
- Test failover scenarios regularly
- Monitor cross-AZ traffic costs

**Common anti-patterns**:
- Deploying all resources in a single AZ
- Not testing AZ failover
- Assuming all AWS services are automatically multi-AZ
- Ignoring data consistency during AZ failures

**Relationship**: Directly relates to VPC subnet configuration, RDS deployment 
options, ECS service placement, Auto Scaling Group configuration.

**Technical Relevancy score:** 10
```

### Purpose
- Provides **expert knowledge** about each best practice
- Explains **why** it matters (risk levels)
- Shows **how** to implement it (guidance)
- Lists **what not to do** (anti-patterns)
- Helps Claude determine **relevance** (Technical Relevancy score)
- Gives Claude the context to write **detailed recommendations**

### Characteristics
- **Large**: Typically 10 document chunks with detailed content
- **Unstructured**: Markdown/text format
- **Dynamic**: Retrieved via vector search based on the question
- **Informative**: Provides deep knowledge and context

---

## How They Work Together

Think of it like this:

| Component | Analogy | Role |
|-----------|---------|------|
| **Best Practices JSON** | Exam questions | "Here are the 5 things you must check" |
| **KB Context** | Textbook/study guide | "Here's everything you need to know to answer those questions correctly" |
| **IaC Template** | Student's answer sheet | "Here's what the student submitted" |
| **Claude's Response** | Graded exam | "Here's my assessment of each answer" |

---

## In the Prompt Flow

### Step-by-Step Process

```typescript
// Step 1: Get the checklist (Best Practices JSON)
const bestPracticesJson = {
  pillar: "Reliability",
  question: "How do you design for failure?",
  bestPractices: [
    "Implement health checks", 
    "Use multi-AZ deployments", 
    "Configure auto-scaling"
  ]
};

// Step 2: Get the expert knowledge (KB Context via RAG)
const kbContexts = await retrieveFromKnowledgeBase(
  "Reliability", 
  "How do you design for failure?",
  domainQuestion,
  "SaaS Resilience"
);
// Returns: Array of detailed documentation about health checks, 
// Multi-AZ, auto-scaling from Well-Architected whitepapers

// Step 3: Combine them in the prompt
const prompt = `
  <best_practices_json>
  ${JSON.stringify(bestPracticesJson, null, 2)}
  </best_practices_json>

  <kb>
  ${kbContexts.join('\n\n')}
  </kb>
`;

// Step 4: Claude uses BOTH to analyze the template
// - Best Practices JSON: Knows WHAT to check
// - KB Context: Knows HOW to check it and WHY it matters
```

### Visual Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Domain Configuration                                     │
│    ├─ Question: "How do you design for failure?"           │
│    └─ Best Practices JSON: ["Health checks", "Multi-AZ"]   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. RAG Query to Bedrock Knowledge Base                     │
│    ├─ Input: Best Practices JSON                           │
│    ├─ Vector Search: Titan Embeddings V2                   │
│    ├─ Filter: domain="SaaS Resilience", pillar="Reliability"│
│    └─ Output: KB Context (10 document chunks)              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Combined Prompt to Claude                               │
│    ├─ System Prompt: "You are an AWS Solutions Architect"  │
│    ├─ Best Practices JSON: Checklist of what to evaluate   │
│    ├─ KB Context: Detailed guidance on how to evaluate     │
│    └─ IaC Template: The code to analyze                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Claude's Analysis                                        │
│    For each item in Best Practices JSON:                   │
│    ├─ Uses KB Context to understand the best practice      │
│    ├─ Checks Technical Relevancy score (relevant if ≥7)    │
│    ├─ Analyzes IaC template for implementation evidence    │
│    └─ Generates detailed response with recommendations     │
└─────────────────────────────────────────────────────────────┘
```

---

## Why Both Are Needed

### Without Best Practices JSON:
❌ Claude wouldn't know which specific practices to evaluate  
❌ Might miss important best practices  
❌ Could evaluate irrelevant practices  
❌ Response format would be inconsistent  
❌ No guarantee all practices are checked  

### Without KB Context:
❌ Claude would rely only on its training data (could be outdated)  
❌ Wouldn't have specific AWS Well-Architected guidance  
❌ Couldn't determine Technical Relevancy scores  
❌ Recommendations would be generic, not specific to AWS best practices  
❌ Might not know about latest AWS services or patterns  
❌ No risk level information  
❌ No anti-patterns guidance  

### With Both Together:
✅ Structured evaluation of all required best practices  
✅ Up-to-date AWS Well-Architected guidance  
✅ Accurate relevancy determination  
✅ Detailed, actionable recommendations  
✅ Consistent response format  
✅ Complete coverage of the lens/domain  

---

## Real Example from the Code

### Building the KB Query

From `knowledge-base-prompts.ts`:

```typescript
export function buildKnowledgeBaseInputPrompt(
  question: string, 
  pillar: string, 
  domainQuestion: DomainQuestion,  // Contains Best Practices JSON
  lensName?: string
): string {
  // Extract the Best Practices JSON from domain configuration
  const bestPracticesJson = JSON.stringify({
    pillar: domainQuestion.pillar,
    question: domainQuestion.title,
    bestPractices: domainQuestion.bestPractices.map(bp => bp.name)
  }, null, 2);

  const lensContext = lensName && lensName !== 'Well-Architected Framework' 
    ? `AWS Well-Architected ${lensName} pillar "${pillar}"` 
    : `Well-Architected pillar "${pillar}"`;

  // Send Best Practices JSON to KB to retrieve detailed context
  return `Below <best_practices_to_retrieve> section contains the list of 
  best practices of the question "${question}" in the ${lensContext}:
  
  <best_practices_to_retrieve>
  ${bestPracticesJson}
  </best_practices_to_retrieve>
  
  For each best practice provide:
  - Name of the Best Practice
  - Level of risk exposed if this best practice is not established
  - Implementation guidance details
  - List common anti-patterns (if any)
  - Does this best practice directly relates to AWS resources, configurations, 
    architecture patterns, or technical implementations? Or, does it primarily 
    concerns organizational processes, team structures, or governance?`;
}
```

### The RAG Retrieval

From `analyzer.service.ts`:

```typescript
private async retrieveFromKnowledgeBase(
  pillar: string,
  question: string,
  domainQuestion: DomainQuestion,
  domainName?: string
): Promise<string[]> {
  const bedrockAgent = this.awsConfig.createBedrockAgentClient();
  const knowledgeBaseId = this.configService.get<string>('aws.bedrock.knowledgeBaseId');

  // Filter KB documentation per domain and pillar
  let filter;
  if (domainName) {
    filter = {
      andAll: [
        { equals: { key: "domain_name", value: domainName } },
        { equals: { key: "pillar", value: pillar } }
      ]
    };
  }

  const command = new RetrieveAndGenerateCommand({
    input: {
      // Send Best Practices JSON to KB
      text: Prompts.buildKnowledgeBaseInputPrompt(
        question, 
        pillar, 
        domainQuestion, 
        domainName
      ),
    },
    retrieveAndGenerateConfiguration: {
      type: "KNOWLEDGE_BASE",
      knowledgeBaseConfiguration: {
        knowledgeBaseId: knowledgeBaseId,
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 10,  // Retrieve 10 document chunks
            filter: filter
          },
        }
      }
    }
  });

  const response = await bedrockAgent.send(command);
  
  // Return KB Context as array
  return response.output?.text ? [response.output.text] : [];
}
```

### Combining in the Analysis Prompt

From `analysis-prompts.ts`:

```typescript
export function buildPrompt(
  question: DomainQuestion,
  kbContexts: string[],  // KB Context from RAG
  supportingDocName?: string,
  supportingDocDescription?: string
): string {
  // Best Practices JSON
  const bestPracticesJson = JSON.stringify({
    pillar: question.pillar,
    question: question.title,
    bestPractices: question.bestPractices.map(bp => bp.name)
  }, null, 2);

  // Combine both in the prompt
  let prompt = `
  <best_practices_json>
  ${bestPracticesJson}
  </best_practices_json>

  <kb>
  ${kbContexts.join('\n\n')}
  </kb>
  `;

  return prompt;
}
```

---

## Comparison Table

| Aspect | Best Practices JSON | KB Context |
|--------|-------------------|------------|
| **What it is** | Structured checklist | Detailed documentation |
| **Source** | Domain configuration | RAG from Knowledge Base |
| **Format** | JSON array of names | Markdown text with guidance |
| **Size** | Small (~5 items) | Large (~10 document chunks) |
| **Purpose** | Define WHAT to check | Explain HOW to check it |
| **Content** | Practice names only | Risk levels, guidance, anti-patterns, relevancy scores |
| **Changes** | Rarely (fixed per lens) | Never (static docs in KB) |
| **Retrieved via** | Configuration file | Vector search with embeddings |
| **Claude uses it to** | Know which practices to evaluate | Understand how to evaluate them |
| **In prompt** | `<best_practices_json>` section | `<kb>` section |
| **Example size** | ~200 bytes | ~10,000+ bytes |
| **Determines** | Scope of analysis | Quality of analysis |

---

## Key Takeaways

1. **Best Practices JSON** = The **structure** (what to evaluate)
2. **KB Context** = The **substance** (how to evaluate it)
3. **Together** = Accurate, comprehensive, AWS-specific Well-Architected reviews

The Best Practices JSON ensures **completeness** (all practices are checked), while the KB Context ensures **accuracy** (practices are evaluated correctly using official AWS guidance).

Without the Best Practices JSON, the analysis would be unstructured and incomplete.  
Without the KB Context, the analysis would be generic and potentially outdated.  
**Together, they enable Claude to be an expert AWS Well-Architected reviewer.**

---

## Related Files

- **KB Query Building**: `ecs_fargate_app/backend/src/prompts/knowledge-base-prompts.ts`
- **Analysis Prompts**: `ecs_fargate_app/backend/src/prompts/analysis-prompts.ts`
- **RAG Implementation**: `ecs_fargate_app/backend/src/modules/analyzer/analyzer.service.ts` (method: `retrieveFromKnowledgeBase()`)
- **Domain Configuration**: `ecs_fargate_app/backend/src/config/domain.config.ts`
- **System Prompts**: `ecs_fargate_app/backend/src/prompts/system-prompts.ts`
