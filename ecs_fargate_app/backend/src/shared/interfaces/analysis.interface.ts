export interface AnalysisResult {
  pillar: string;
  question: string;
  questionId: string;
  bestPractices: BestPractice[];
  /** SMA-specific fields (optional — only present for SaaS Maturity Assessment results) */
  category?: string;
  maturityLevel?: number | null;
  confidence?: 'high' | 'medium' | 'low';
  iacEvidence?: string | null;
  maturityJustification?: string;
  processAssessmentNote?: string | null;
  recommendations?: string;
  relevantResources?: string[];
}

export interface BestPractice {
  id: string;
  name: string;
  relevant: boolean;
  applied: boolean;
  reasonApplied?: string;
  reasonNotApplied?: string;
  recommendations?: string;
}

export interface RiskSummary {
  pillarName: string;
  totalQuestions: number;
  answeredQuestions: number;
  highRisks: number;
  mediumRisks: number;
}

export interface WorkloadReview {
  workloadId: string;
  lensAlias: string;
  results: AnalysisResult[];
}

export interface QuestionGroup {
  pillar: string;
  title: string;
  questionId: string;
  bestPractices: string[];
  bestPracticeIds: string[];
}