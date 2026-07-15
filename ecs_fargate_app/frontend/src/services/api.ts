import axios, { AxiosError } from 'axios';
import { AnalysisResult, RiskSummaryResponse, IaCTemplateType, FileUploadMode, LensMetadata } from '../types';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 0, // Allow for long-running operations
});

// Move handleError outside as a standalone function
const handleError = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ message: string }>;

    // Check for network interruption errors
    if (axiosError.message.includes('Network Error') ||
      axiosError.message.includes('ERR_NETWORK') ||
      axiosError.code === 'ERR_NETWORK' ||
      !axiosError.response) {
      return new Error(
        'NETWORK_INTERRUPTION: Network connection was interrupted. ' +
        'Your analysis is likely still running in the background. ' +
        'Please check the side navigation panel to load your results.'
      );
    }

    return new Error(
      axiosError.response?.data?.message ||
      axiosError.message ||
      'An unexpected error occurred'
    );
  }
  return new Error('An unexpected error occurred');
};

export const analyzerApi = {
  // Fetch domain metadata
  async getDomainMetadata(): Promise<any[]> {
    try {
      const response = await api.get('/domain/metadata');
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  // Fetch lens metadata (kept for backward compatibility)
  async getLensMetadata(): Promise<LensMetadata[]> {
    try {
      const response = await api.get('/well-architected/lens-metadata');
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async associateLenses(workloadId: string, lensAliasArn?: string): Promise<void> {
    try {
      if (!lensAliasArn) {
        return; // Skip if no lens alias provided
      }

      await api.post(`/well-architected/associate-lens/${workloadId}`, {
        lensAliasArn
      });
    } catch (error) {
      throw handleError(error);
    }
  },

  async analyze(
    fileId: string,
    workloadId: string,
    selectedDomain: string,
    uploadMode?: FileUploadMode,
    supportingDocumentId?: string,
    supportingDocumentDescription?: string,
    isTempWorkload?: boolean,
    outputLanguage?: string
  ): Promise<{ results: AnalysisResult[]; isCancelled: boolean; error?: string; fileId?: string }> {
    try {
      const response = await api.post('/analyzer/analyze', {
        fileId,
        workloadId,
        selectedDomain,
        uploadMode,
        supportingDocumentId,
        supportingDocumentDescription,
        isTempWorkload,
        outputLanguage,
      });
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async cancelAnalysis(): Promise<void> {
    try {
      await api.post('/analyzer/cancel-analysis');
    } catch (error) {
      throw handleError(error);
    }
  },

  async updateWorkload(workloadId: string, questionId: string, selectedChoices: string[], notApplicableChoiceIds: string[] = [], notSelectedChoices: string[], lensAliasArn?: string) {
    try {
      const response = await api.post(`/well-architected/answer/${workloadId}`, {
        questionId,
        selectedChoices,
        notApplicableChoices: notApplicableChoiceIds,
        notSelectedChoices,
        lensAliasArn,
      });
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async updateWorkItem(fileId: string, updates: any): Promise<void> {
    try {
      await api.post(`/storage/work-items/${fileId}/update`, updates);
    } catch (error) {
      throw handleError(error);
    }
  },

  async getRiskSummary(workloadId: string, lensAliasArn?: string): Promise<RiskSummaryResponse> {
    try {
      const response = await api.post('/well-architected/risk-summary', {
        workloadId,
        lensAliasArn
      });
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async createMilestone(workloadId: string, milestoneName: string) {
    try {
      const response = await api.post('/well-architected/milestone', {
        workloadId,
        milestoneName,
      });
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async generateReport(workloadId: string, lensAliasArn?: string): Promise<string> {
    try {
      const response = await api.post('/report/generate', {
        workloadId,
        lensAliasArn
      });
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async generateRecommendations(results: AnalysisResult[]): Promise<string> {
    try {
      const response = await api.post('/report/recommendations', results);
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async generateSMARecommendations(results: AnalysisResult[]): Promise<string> {
    try {
      const response = await api.post('/report/sma-recommendations', results);
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async generateSMAReport(results: AnalysisResult[], fileName?: string, outputLanguage?: string): Promise<string> {
    try {
      const response = await api.post('/report/sma-report', {
        results,
        fileName,
        outputLanguage,
      });
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async createWorkload(isTemp: boolean = false, lensAliasArn?: string): Promise<string> {
    try {
      const response = await api.post('/well-architected/workload/create', {
        isTemp,
        lensAliasArn
      });
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async deleteWorkload(workloadId: string): Promise<void> {
    try {
      await api.delete(`/well-architected/workload/${workloadId}`);
    } catch (error) {
      throw handleError(error);
    }
  },

  async generateIacDocument(
    fileId: string,
    recommendations: AnalysisResult[],
    templateType: IaCTemplateType,
    domain?: string,
    outputLanguage?: string,
  ): Promise<{ content: string; isCancelled: boolean; error?: string }> {
    try {
      const response = await api.post('/analyzer/generate-iac', {
        fileId,
        recommendations,
        templateType,
        domain,
        outputLanguage,
      });
      return response.data;
    } catch (error) {
      // Return the error response
      return {
        content: '',
        isCancelled: false,
        error: error instanceof Error ? error.message : 'Failed to generate IaC document'
      };
    }
  },

  async getMoreDetails(
    selectedItems: AnalysisResult[],
    fileId: string,
    templateType: IaCTemplateType,
    domain?: string,
    outputLanguage?: string,
  ): Promise<{ content: string; error?: string }> {
    try {
      const response = await api.post('/analyzer/get-more-details', {
        selectedItems,
        fileId,
        templateType,
        domain,
        outputLanguage,
      });
      return response.data;
    } catch (error) {
      return {
        content: '',
        error: error instanceof Error ? error.message : 'Failed to get detailed analysis'
      };
    }
  },

  async cancelIaCGeneration(): Promise<void> {
    try {
      await api.post('/analyzer/cancel-iac-generation');
    } catch (error) {
      throw handleError(error);
    }
  },

  async storeAnalysisResults(fileId: string, results: AnalysisResult[]): Promise<void> {
    try {
      await api.post(`/analyzer/store-results/${fileId}`, {
        results
      });
    } catch (error) {
      throw handleError(error);
    }
  },

  async sendChatMessage(fileId: string, message: string, domain?: string): Promise<{ content: string }> {
    try {
      const response = await api.post('/analyzer/chat', {
        fileId,
        message,
        domain
      });
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  },

  async listWorkloads(): Promise<any[]> {
    try {
      const response = await api.get('/well-architected/workloads');
      return response.data;
    } catch (error) {
      throw handleError(error);
    }
  }
};