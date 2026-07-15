import { SMAQuestion } from './sma-system-prompts';

/**
 * SMA-specific Knowledge Base prompts.
 * 
 * Follows the same pattern as standard KB prompts (knowledge-base-prompts.ts).
 * 
 * Key differences:
 * - KB is queried with lens_name="SaaS Lens" filter (Option 3) in analyzer.service.ts
 * - Input prompt uses question text + pillar + category (clean, focused query)
 * - Rating descriptions are NOT included in KB query to avoid diluting semantic search
 * - Rating descriptions live in the system prompt where the LLM uses them as maturity rubric
 * - Generation template follows standard format with Technical Relevancy score
 */

/**
 * Builds the input text prompt for KB retrieval for SMA questions.
 * Keeps the query clean and focused for optimal semantic search retrieval.
 */
export function buildSMAKnowledgeBaseInputPrompt(
  question: SMAQuestion
): string {
  const questionContext = JSON.stringify({
    pillar: question.pillar,
    category: question.category,
    question: question.title
  }, null, 2);

  return `Below <best_practices_to_retrieve> section contains the SaaS Maturity Assessment question "${question.title}" in the AWS Well-Architected SaaS Lens pillar "${question.pillar}", category "${question.category}":
<best_practices_to_retrieve>
${questionContext}
</best_practices_to_retrieve>
For the best practices related to this question provide:
- Name of the Best Practice
- Level of risk exposed if this best practice is not established
- Implementation guidance details
- List common anti-patterns (if any)
- Does this best practice directly relates to AWS resources, configurations, architecture patterns, or technical implementations? Or, does it primarily concerns organizational processes, team structures, or governance?`;
}

/**
 * Builds the prompt template for KB generation configuration for SMA.
 * Follows the same format as buildKnowledgeBasePromptTemplate() for consistency.
 */
export function buildSMAKnowledgeBasePromptTemplate(): string {
  return `You are an AWS Well-Architected SaaS Lens expert. Using the following retrieved information about the SaaS Lens best practices:
  
  $search_results$
  
  Answer the following query:
  
  Provide a comprehensive response that covers each best practice, its associated risk level, implementation guidance and a list of common anti-patterns (if any). Format your response clearly with proper headings and bullet points such as:
  
  ## <Best Practice ID : Best Practice Name> (e.g. SaaS-SEC-01: Implement Tenant Isolation)
  
  **Risk Level**: <Associated risk level>
  
  **Implementation Guidance**:
  
  <bullet points with implementation guidance details>
  
  **Common anti-patterns**:
  
  <bullet points with list common anti-patterns (if any)>
  
  **Relationship**: <Answers to the mentioned question Does this best practice directly relates to AWS resources, configurations, architecture patterns, or technical implementations? Or, does it primarily concerns organizational processes, team structures, or governance?>
  
  **Technical Relevancy score:** <1 to 10, where 1 is not related at all to AWS resources, configurations, architecture patterns, or technical implementations while 10 is fully related to them>`;
}
