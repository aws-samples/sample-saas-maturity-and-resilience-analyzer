import { SMAQuestion } from './sma-system-prompts';

/**
 * SMA-specific analysis prompts (user prompts).
 * These carry the KB context and supporting document references to the model.
 */

/**
 * Builds the SMA analysis prompt for IaC template assessment
 */
export function buildSMAPrompt(
  question: SMAQuestion,
  kbContexts: string[],
  supportingDocName?: string,
  supportingDocDescription?: string
): string {
  let prompt = `
  <sma_question>
  <pillar>${question.pillar}</pillar>
  <category>${question.category}</category>
  <question>${question.title}</question>
  </sma_question>

  <kb>
  ${kbContexts.join('\n\n')}
  </kb>
`;

  if (supportingDocName && supportingDocDescription) {
    prompt += `
  
  <supporting_document>
  <description>
  The attached file named "${supportingDocName}" has been provided as a supporting document that contains CRITICAL context for your assessment.

  IMPORTANT INSTRUCTIONS:
  1. Begin by thoroughly examining this supporting document BEFORE analyzing the IaC template
  2. Extract all relevant information about SaaS architecture patterns, tenant management, and multi-tenant configurations
  3. When assessing maturity level, consider evidence from BOTH the IaC template AND the supporting document
  4. If your assessment is influenced by this supporting document, use "[From Supporting Doc]" prefix in your evidence citations
  
  Below is a brief description of the supporting document attached: 
  ${supportingDocDescription}
  </description>
  </supporting_document>
  `;
  }

  return prompt;
}

/**
 * Builds the SMA analysis prompt for project (multi-file) assessment
 */
export function buildSMAProjectPrompt(
  question: SMAQuestion,
  kbContexts: string[],
  supportingDocName?: string,
  supportingDocDescription?: string
): string {
  let prompt = `
  <sma_question>
  <pillar>${question.pillar}</pillar>
  <category>${question.category}</category>
  <question>${question.title}</question>
  </sma_question>

  <kb>
  ${kbContexts.join('\n\n')}
  </kb>
`;

  if (supportingDocName && supportingDocDescription) {
    prompt += `
  
  <supporting_document>
  <description>
  The attached file named "${supportingDocName}" has been provided as a supporting document.
  Examine it BEFORE analyzing the IaC project. Use "[From Supporting Doc]" prefix when citing evidence from it.
  
  Description: ${supportingDocDescription}
  </description>
  </supporting_document>
  `;
  }

  return prompt;
}

/**
 * Builds the SMA analysis prompt for architecture diagram assessment
 */
export function buildSMAImagePrompt(
  question: SMAQuestion,
  kbContexts: string[],
  supportingDocName?: string,
  supportingDocDescription?: string
): string {
  let prompt = `
  <sma_question>
  <pillar>${question.pillar}</pillar>
  <category>${question.category}</category>
  <question>${question.title}</question>
  </sma_question>

  <kb>
  ${kbContexts.join('\n\n')}
  </kb>
`;

  if (supportingDocName && supportingDocDescription) {
    prompt += `
  
  <supporting_document>
  <description>
  The attached file named "${supportingDocName}" has been provided as a supporting document.
  Examine it BEFORE analyzing the architecture diagram. Use "[From Supporting Doc]" prefix when citing evidence from it.
  
  Description: ${supportingDocDescription}
  </description>
  </supporting_document>
  `;
  }

  return prompt;
}
