import { Injectable, Logger } from '@nestjs/common';
import { AwsConfigService } from '../../config/aws.config';
import {
    ConverseCommand,
    Message,
    SystemContentBlock,
    ThrottlingException as BedrockThrottlingException
} from '@aws-sdk/client-bedrock-runtime';
import {
    RetrieveAndGenerateCommand,
    ThrottlingException as BedrockAgentThrottlingException
} from '@aws-sdk/client-bedrock-agent-runtime';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { paginateListAnswers, AnswerSummary } from '@aws-sdk/client-wellarchitected';
import { ConfigService } from '@nestjs/config';
import { AnalyzerGateway } from './analyzer.gateway';
import { IaCTemplateType } from '../../shared/dto/analysis.dto';
import { Subject } from 'rxjs';
import { AnalysisResult } from '../../shared/interfaces/analysis.interface';
import { StorageService } from '../storage/storage.service';
import * as Prompts from '../../prompts';
import { FileUploadMode } from '../../shared/dto/analysis.dto';
import { LensInfo } from '../../shared/interfaces/storage.interface';
import { getDomainConfig, DomainQuestion } from '../../config/domain.config';
import { SMAQuestion } from '../../prompts/sma-system-prompts';
import { QuestionsService } from '../questions/questions.service';


interface QuestionGroup {
    pillar: string;
    title: string;
    questionId: string;
    bestPractices: string[];
    bestPracticeIds: string[];
}

interface WellArchitectedBestPractice {
    Pillar: string;
    Question: string;
    questionId: string;
    'Best Practice': string;
    bestPracticeId: string;
    pillarId: string;
}

interface BestPractice {
    name: string;
    relevant: boolean;
    applied: boolean;
    reasonApplied: string;
    reasonNotApplied: string;
    recommendations: string;
    extendedRecommendations?: string;
}

interface ModelResponse {
    bestPractices: BestPractice[];
}

interface WellArchitectedAnswer {
    AnswerSummaries: AnswerSummary[];
    WorkloadId: string;
    LensAlias?: string;
    LensArn?: string;
}

interface DocumentSection {
    content: string;
    order: number;
    description: string;
}

interface ModelSectionResponse {
    isComplete: boolean;
    sections: DocumentSection[];
}

interface QuestionAnalysisTask {
    question: DomainQuestion;
    questionIndex: number;
}

@Injectable()
export class AnalyzerService {
    private readonly logger = new Logger(AnalyzerService.name);
    private cachedBestPractices: WellArchitectedBestPractice[] | null = null;
    private cancelGeneration$ = new Subject<void>();
    private cancelAnalysis$ = new Subject<void>();
    private readonly storageEnabled: boolean;
    private readonly outputLanguage: string; // Add language setting
    private readonly BATCH_SIZE: number;
    private readonly SMA_BATCH_SIZE: number;

    constructor(
        private readonly awsConfig: AwsConfigService,
        private readonly configService: ConfigService,
        private readonly analyzerGateway: AnalyzerGateway,
        private readonly storageService: StorageService,
        private readonly questionsService: QuestionsService,
    ) {
        this.storageEnabled = this.configService.get<boolean>('storage.enabled', false);
        this.outputLanguage = this.configService.get<string>('language.output', 'en'); // Get language from config
        this.BATCH_SIZE = this.configService.get<number>('analysis.batchSize', 5);
        this.SMA_BATCH_SIZE = this.configService.get<number>('analysis.smaBatchSize', 3);
    }

    /**
     * Retry helper with exponential backoff for throttling exceptions.
     * Both KB retrieval and model invocation should be wrapped in this.
     */
    private async retryWithExponentialBackoff<T>(
        operation: () => Promise<T>,
        maxRetries: number = 5,
        initialDelayMs: number = 30000, // Start with 30 seconds
        operationName: string = 'operation'
    ): Promise<T> {
        let lastError: Error;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;

                // Check if it's a throttling exception
                const isThrottlingException =
                    error instanceof BedrockThrottlingException ||
                    error instanceof BedrockAgentThrottlingException ||
                    error?.name === 'ThrottlingException' ||
                    error?.message?.includes('ThrottlingException') ||
                    error?.message?.includes('Rate exceeded');

                if (!isThrottlingException || attempt === maxRetries) {
                    throw error;
                }

                // Calculate delay with exponential backoff: initialDelay * 2^attempt
                const delayMs = initialDelayMs * Math.pow(2, attempt);

                this.logger.warn(
                    `${operationName} throttled (attempt ${attempt + 1}/${maxRetries + 1}). ` +
                    `Retrying in ${delayMs / 1000} seconds...`
                );

                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        throw lastError;
    }

    /**
     * Process a batch of questions in parallel.
     * Each question's KB retrieval + model call runs concurrently within the batch.
     * Progress is emitted per-question as each completes (not after the whole batch).
     */
    private async processBatch(
        tasks: QuestionAnalysisTask[],
        fileContent: string | any,
        fileType: string,
        uploadMode: FileUploadMode,
        supportingDocContent: string | null,
        supportingDocType: string | null,
        supportingDocName: string | null,
        supportingDocumentDescription: string | null,
        domainConfig: { name: string; pillars?: string[] },
        currentOutputLanguage: string,
        totalQuestions: number,
        processedCountRef: { value: number },
    ): Promise<AnalysisResult[]> {
        const batchPromises = tasks.map(async (task) => {
            try {
                // Emit progress before processing this question
                this.analyzerGateway.emitAnalysisProgress({
                    processedQuestions: processedCountRef.value,
                    totalQuestions,
                    currentPillar: task.question.pillar,
                    currentQuestion: task.question.title,
                    currentCategory: (task.question as any).category,
                });

                // Retrieve from knowledge base with retry
                const kbContexts = await this.retryWithExponentialBackoff(
                    () => this.retrieveFromKnowledgeBase(
                        task.question.pillar,
                        task.question.title,
                        task.question,
                        domainConfig.name
                    ),
                    5,
                    30000,
                    `KB retrieval for ${task.question.pillar} - ${task.question.title}`
                );

                // Analyze question with retry
                const analysis = await this.retryWithExponentialBackoff(
                    () => this.analyzeQuestion(
                        fileContent,
                        task.question,
                        kbContexts,
                        fileType,
                        uploadMode,
                        supportingDocContent,
                        supportingDocType,
                        supportingDocName,
                        supportingDocumentDescription,
                        domainConfig.name,
                        domainConfig.pillars,
                        currentOutputLanguage
                    ),
                    5,
                    30000,
                    `Analysis for ${task.question.pillar} - ${task.question.title}`
                );

                // Increment processed count and emit progress after completion
                processedCountRef.value++;
                this.analyzerGateway.emitAnalysisProgress({
                    processedQuestions: processedCountRef.value,
                    totalQuestions,
                    currentPillar: task.question.pillar,
                    currentQuestion: task.question.title,
                    currentCategory: (task.question as any).category,
                });

                this.logger.log(
                    `Completed question ${processedCountRef.value}/${totalQuestions}: ` +
                    `${task.question.pillar} - ${task.question.title}`
                );

                return analysis;
            } catch (error) {
                this.logger.error(
                    `Failed to process question "${task.question.pillar} - ${task.question.title}":`,
                    error
                );
                throw error;
            }
        });

        // Wait for all batch operations to complete
        const results = await Promise.all(batchPromises);
        return results;
    }


    // Check if the current model is Claude 3.7 Sonnet
    private isClaudeSonnet37(): boolean {
        const modelId = this.configService.get<string>('aws.bedrock.modelId');
        return modelId && (
            modelId.includes('anthropic.claude-3-7-sonnet') ||
            modelId.includes('us.anthropic.claude-3-7-sonnet')
        );
    }

    // Configure model parameters based on the model type
    private getModelParameters() {
        const isClaudeSonnet37 = this.isClaudeSonnet37();

        if (isClaudeSonnet37) {
            return {
                additionalModelRequestFields: {
                    thinking: {
                        type: "enabled",
                        budget_tokens: 8000
                    }
                },
                inferenceConfig: {
                    maxTokens: 20480
                }
            };
        }

        return {
            inferenceConfig: {
                maxTokens: 8192,
                temperature: 0.7
            }
        };
    }

    /**
     * Chat functionality - allows users to ask questions about their analysis results
     * @param fileId The ID of the file/analysis to discuss
     * @param message The user's message
     * @param userId The user ID for looking up relevant data
     * @returns A response message from the AI assistant
     */
    async chat(fileId: string, message: string, userId: string, domain?: string): Promise<string> {
        try {
            if (!fileId || !userId) {
                throw new Error('File ID and User ID are required for chat');
            }

            // Get work item and analysis results
            const workItem = await this.storageService.getWorkItem(userId, fileId);

            if (!workItem) {
                throw new Error('Work item not found');
            }

            // Only allow chat if analysis is completed or partial for any domain
            const hasCompletedAnalysis = workItem.analysisStatus &&
                Object.values(workItem.analysisStatus).some(status =>
                    status === 'COMPLETED' || status === 'PARTIAL'
                );

            if (!hasCompletedAnalysis) {
                throw new Error('Analysis must be completed before chatting');
            }

            // Get analysis results for the specified domain or the first available domain
            const domainToUse = domain || Object.keys(workItem.analysisStatus || {})[0];
            const analysisResults = await this.storageService.getAnalysisResults(userId, fileId, domainToUse);

            if (!analysisResults || !Array.isArray(analysisResults) || analysisResults.length === 0) {
                throw new Error('No analysis results found for this file');
            }

            // Check upload mode to determine how to get file content
            const uploadMode = workItem.uploadMode || FileUploadMode.SINGLE_FILE;
            const isImageFile = workItem.fileType.startsWith('image/');

            // Declare variables for file content
            let fileContent;
            let fileType = workItem.fileType;
            let contentStr = '';

            // Get appropriate content based on upload mode
            if (uploadMode === FileUploadMode.SINGLE_FILE) {
                // Get the original content for single files
                const result = await this.storageService.getOriginalContent(userId, fileId, false);
                fileContent = result.data;
                fileType = result.contentType;
            } else {
                // For multiple files or ZIP files, get the packed content
                try {
                    contentStr = await this.storageService.getPackedContent(userId, fileId);
                } catch (error) {
                    this.logger.warn(`Packed content not found for ${fileId}, falling back to original content`);
                    // Fall back to original content
                    const result = await this.storageService.getOriginalContent(userId, fileId, false);
                    fileContent = result.data;
                    fileType = result.contentType;
                }
            }

            // Prepare analysis context for the LLM
            const isSMA = domainToUse === 'saas_maturity_assessment';
            let analysisContext;
            let systemPrompt: string;

            if (isSMA) {
                // SMA context includes maturity-specific fields
                analysisContext = analysisResults.map(result => ({
                    pillar: result.pillar,
                    question: result.question,
                    category: result.category,
                    maturityLevel: result.maturityLevel,
                    confidence: result.confidence,
                    iacEvidence: result.iacEvidence,
                    maturityJustification: result.maturityJustification,
                    processAssessmentNote: result.processAssessmentNote,
                    recommendations: result.recommendations,
                    relevantResources: result.relevantResources,
                }));

                systemPrompt = Prompts.buildSMAChatSystemPrompt(
                    uploadMode,
                    analysisContext,
                    fileType
                );
            } else {
                analysisContext = analysisResults.map(result => ({
                    pillar: result.pillar,
                    question: result.question,
                    bestPractices: result.bestPractices.map(bp => ({
                        name: bp.name,
                        relevant: bp.relevant,
                        applied: bp.applied,
                        reasonApplied: bp.reasonApplied,
                        reasonNotApplied: bp.reasonNotApplied,
                        recommendations: bp.recommendations,
                    }))
                }));

                const domainConfig = getDomainConfig(domainToUse);
                systemPrompt = Prompts.buildChatSystemPrompt(
                    uploadMode,
                    analysisContext,
                    fileType,
                    domainConfig?.name || 'Analysis Domain'
                );
            }

            // Retrieve chat history
            let chatHistory = [];
            try {
                chatHistory = await this.storageService.getChatHistory(userId, fileId);
            } catch (error) {
                // If chat history doesn't exist, we will start a new conversation
                this.logger.log('No existing chat history found, starting new conversation');
            }

            // Create array of messages for conversation
            const messages: Message[] = [];

            // Add previous messages from chat history to maintain conversation context
            if (chatHistory && chatHistory.length > 0) {
                // Convert chat history format to Bedrock message format
                // We only need the last few messages to stay within context limits
                const recentMessages = chatHistory.slice(-25); // Last 25 messages

                for (const msg of recentMessages) {
                    messages.push({
                        role: msg.isUser ? 'user' : 'assistant',
                        content: [
                            {
                                text: msg.content
                            }
                        ]
                    });
                }
            }

            // System message as content block 
            const systemContentBlock: SystemContentBlock[] = [{
                text: systemPrompt
            }];

            // Get model parameters based on model type
            const modelParams = this.getModelParameters();
            const bedrockClient = this.awsConfig.createBedrockClient();
            let response;

            // Create user message with the question
            const userMessage: Message = {
                role: 'user',
                content: [{ text: message }]
            };

            // Handle PDF files
            if (uploadMode === FileUploadMode.PDF_FILE) {
                // Get the PDF files
                const { data: pdfFiles } = await this.storageService.getOriginalContent(
                    userId,
                    fileId,
                    false
                );

                // Add PDF files to the message (up to 5 PDFs)
                if (Array.isArray(pdfFiles)) {
                    const pdfsToAdd = pdfFiles.slice(0, 5); // Take first 5 PDFs
                    for (const pdfFile of pdfsToAdd) {
                        userMessage.content.push({
                            document: {
                                format: "pdf",
                                name: this.normalizeFileName(pdfFile.filename),
                                source: { bytes: pdfFile.buffer },
                                // Adding citations property to enable enhanced PDF visual understanding
                                citations: {
                                    enabled: true
                                }
                            }
                        });
                    }
                }

                // Add user message to messages array
                messages.push(userMessage);

                // Create the Converse command for PDFs
                const command = new ConverseCommand({
                    modelId: this.configService.get<string>('aws.bedrock.modelId'),
                    messages: messages,
                    system: systemContentBlock,
                    ...modelParams
                });

                response = await bedrockClient.send(command);

                // Process the response
                if (response.output && response.output.message && response.output.message.content) {
                    const content = response.output.message.content;
                    // Handle different content types
                    let responseText = '';
                    for (const block of content) {
                        if ('text' in block) {
                            responseText += block.text || '';
                        }
                    }

                    // Add the user message and AI response to chat history
                    chatHistory.push({
                        id: `user-${Date.now()}`,
                        content: message,
                        timestamp: new Date().toISOString(),
                        isUser: true
                    });

                    chatHistory.push({
                        id: `assistant-${Date.now()}`,
                        content: responseText,
                        timestamp: new Date().toISOString(),
                        isUser: false
                    });

                    // Save the updated chat history
                    await this.storageService.storeChatHistory(userId, fileId, chatHistory);

                    return responseText;
                }

            } else if (uploadMode === FileUploadMode.SINGLE_FILE && isImageFile) {
                // Handle single image file
                let processedContent: string;

                if (Buffer.isBuffer(fileContent)) {
                    processedContent = `data:${fileType};base64,${fileContent.toString('base64')}`;
                } else if (typeof fileContent === 'string' && !fileContent.startsWith('data:')) {
                    processedContent = `data:${fileType};base64,${fileContent}`;
                } else {
                    processedContent = fileContent as string;
                }

                // Extract image data
                const imageBase64Data = processedContent.split(',')[1];
                const imageMediaType = processedContent.split(';')[0].split(':')[1];
                const imageFormat = imageMediaType.split('/')[1]; // Extract format from media type

                // Add the new user message with image content
                const userMessage: Message = {
                    role: 'user',
                    content: [
                        {
                            image: {
                                format: imageFormat as "png" | "jpeg" | "gif" | "webp",
                                source: {
                                    bytes: Buffer.from(imageBase64Data, 'base64')
                                }
                            }
                        },
                        {
                            text: message
                        }
                    ]
                };

                messages.push(userMessage);

                // Create the Converse command for image
                const command = new ConverseCommand({
                    modelId: this.configService.get<string>('aws.bedrock.modelId'),
                    messages: messages,
                    system: systemContentBlock,
                    ...modelParams
                });

                response = await bedrockClient.send(command);
            } else {
                // Handle text-based content (single file, multiple files, or ZIP)
                let fileContentStr: string;

                // For multiple files or ZIP, use the packed content we already retrieved
                if (uploadMode !== FileUploadMode.SINGLE_FILE) {
                    fileContentStr = contentStr;
                } else {
                    // For single file, process the content
                    if (Buffer.isBuffer(fileContent)) {
                        fileContentStr = fileContent.toString('utf-8');
                    } else if (typeof fileContent === 'string') {
                        fileContentStr = fileContent;
                    } else {
                        fileContentStr = JSON.stringify(fileContent);
                    }
                }

                // For projects or large files, ensure it's not too large
                const maxContentLength = 500000; // limiting to ~500k characters
                if (fileContentStr.length > maxContentLength) {
                    fileContentStr = `${fileContentStr.substring(0, maxContentLength)}... [CONTENT TRUNCATED DUE TO SIZE]`;
                }

                // Create a message that includes both file content and user question
                const combinedMessage = `
      FILE CONTENT:
      \`\`\`
      ${fileContentStr}
      \`\`\`
      
      USER QUESTION: ${message}`;

                messages.push({
                    role: 'user',
                    content: [
                        {
                            text: combinedMessage
                        }
                    ]
                });

                // Create the Converse command for text
                const command = new ConverseCommand({
                    modelId: this.configService.get<string>('aws.bedrock.modelId'),
                    messages: messages,
                    system: systemContentBlock,
                    ...modelParams
                });

                response = await bedrockClient.send(command);
            }

            // Extract and return the response
            if (response.output && response.output.message && response.output.message.content) {
                const content = response.output.message.content;
                // Handle different content types
                let responseText = '';
                for (const block of content) {
                    if ('text' in block) {
                        responseText += block.text || '';
                    }
                }

                // Add the user message and AI response to chat history
                chatHistory.push({
                    id: `user-${Date.now()}`,
                    content: message,
                    timestamp: new Date().toISOString(),
                    isUser: true
                });

                chatHistory.push({
                    id: `assistant-${Date.now()}`,
                    content: responseText,
                    timestamp: new Date().toISOString(),
                    isUser: false
                });

                // Save the updated chat history
                await this.storageService.storeChatHistory(userId, fileId, chatHistory);

                return responseText;
            }

            throw new Error('No response generated from AI model');
        } catch (error) {
            this.logger.error('Error in chat:', error);
            throw error;
        }
    }

    /**
 * Gets file content for analysis from storage service
 * @param userId User ID
 * @param fileId File ID
 * @param uploadMode File upload mode
 * @returns File content, type, and relevant metadata
 */
    private async getFileContent(
        userId: string,
        fileId: string,
        uploadMode: FileUploadMode = FileUploadMode.SINGLE_FILE
    ): Promise<{ content: string | any; type: string }> {
        try {

            // Handle PDF files
            if (uploadMode === FileUploadMode.PDF_FILE) {
                // Get the PDF files from storage
                const { data: pdfFiles, contentType } = await this.storageService.getOriginalContent(
                    userId,
                    fileId,
                    false
                );

                // Return the PDF files array to be used in analysis
                return {
                    content: pdfFiles, // Array of { filename, buffer, size }
                    type: contentType, // Will be 'application/pdf-collection'
                };
            }

            // For other file types
            const { data, contentType: type } = await this.storageService.getOriginalContent(
                userId,
                fileId,
                false
            );
            // Convert Buffer to string or handle base64 data
            let content: string | any;
            if (Buffer.isBuffer(data)) {
                // If it's an image, convert to base64
                if (type.startsWith('image/')) {
                    content = `data:${type};base64,${data.toString('base64')}`;
                } else {
                    // For text files (IaC templates), convert to UTF-8 string
                    content = data.toString('utf-8');
                }
            } else {
                content = data;
            }

            return { content, type: type };
        } catch (error) {
            this.logger.error('Error getting file content:', error);
            throw new Error(`Failed to get file content: ${error.message}`);
        }
    }

    /**
     * Get lens name from alias
     */
    private getLensNameFromAlias(lensAlias: string): string {
        // Default names for common lenses
        if (lensAlias === 'wellarchitected') {
            return 'Well-Architected Framework';
        } else if (lensAlias === 'serverless') {
            return 'Serverless Lens';
        } else if (lensAlias === 'saas_resilience') {
            return 'SaaS Resilience';
        }

        // Generic fallback
        return `Lens: ${lensAlias}`;
    }

    private ensureBase64Format(fileContent: string, fileType: string): string {
        // If the content already starts with 'data:', it's already in the correct format
        if (fileContent.startsWith('data:')) {
            return fileContent;
        }

        // Convert Buffer/binary string to base64 and add data URI prefix
        try {
            // If it's a binary string, convert to base64
            const base64Content = Buffer.from(fileContent, 'binary').toString('base64');
            return `data:${fileType};base64,${base64Content}`;
        } catch (error) {
            this.logger.error('Error converting file content to base64:', error);
            throw new Error('Failed to process file content');
        }
    }

    private isImageFile(fileType: string | undefined): boolean {
        if (!fileType) return false;
        return fileType.startsWith('image/');
    }

    cancelAnalysis() {
        this.cancelAnalysis$.next();
    }

    async analyze(
        fileId: string,
        workloadId: string,
        selectedDomain: string,
        uploadMode: FileUploadMode = FileUploadMode.SINGLE_FILE,
        userId?: string,
        supportingDocumentId?: string,
        supportingDocumentDescription?: string,
        outputLanguage?: string
    ): Promise<{ results: AnalysisResult[]; isCancelled: boolean; error?: string; fileId?: string }> {
        const results: AnalysisResult[] = [];
        let workItem;

        try {
            if (!userId) {
                throw new Error('User ID is required for analysis');
            }

            // Get file content from storage
            const { content: fileContent, type: fileType } = await this.getFileContent(userId, fileId, uploadMode);

            // Get existing work item
            workItem = await this.storageService.getWorkItem(userId, fileId);

            // Use provided output language or default from service
            const currentOutputLanguage = outputLanguage || this.outputLanguage;

            // Get domain configuration
            const domainConfig = getDomainConfig(selectedDomain);
            if (!domainConfig) {
                throw new Error(`Invalid domain: ${selectedDomain}`);
            }

            // Get supporting document content if provided
            let supportingDocContent = null;
            let supportingDocType = null;
            let supportingDocName = null;

            if (supportingDocumentId) {
                try {
                    // Note: Passing domain to getSupportingDocument
                    const supportingDoc = await this.storageService.getSupportingDocument(
                        userId,
                        fileId,
                        supportingDocumentId,
                        selectedDomain
                    );

                    // Convert to base64 for images and PDFs, leave as text for text files
                    if (supportingDoc.contentType === 'text/plain') {
                        supportingDocContent = supportingDoc.data.toString('utf8');
                    } else {
                        supportingDocContent = supportingDoc.data.toString('base64');
                    }

                    supportingDocType = supportingDoc.contentType;
                    supportingDocName = supportingDoc.fileName;

                    // Link the supporting document to the work item for this domain
                    // Create/update supporting document record maps
                    const supportingDocIdMap = { ...(workItem.supportingDocumentId || {}) };
                    const supportingDocAddedMap = { ...(workItem.supportingDocumentAdded || {}) };
                    const supportingDocNameMap = { ...(workItem.supportingDocumentName || {}) };
                    const supportingDocTypeMap = { ...(workItem.supportingDocumentType || {}) };
                    const supportingDocDescMap = { ...(workItem.supportingDocumentDescription || {}) };

                    // Set values for this domain
                    supportingDocIdMap[selectedDomain] = supportingDocumentId;
                    supportingDocAddedMap[selectedDomain] = true;
                    supportingDocNameMap[selectedDomain] = supportingDocName;
                    supportingDocTypeMap[selectedDomain] = supportingDocType;
                    supportingDocDescMap[selectedDomain] = supportingDocumentDescription || '';

                    await this.storageService.updateWorkItem(userId, fileId, {
                        supportingDocumentId: supportingDocIdMap,
                        supportingDocumentAdded: supportingDocAddedMap,
                        supportingDocumentName: supportingDocNameMap,
                        supportingDocumentType: supportingDocTypeMap,
                        supportingDocumentDescription: supportingDocDescMap,
                        lastModified: new Date().toISOString(),
                    });
                } catch (error) {
                    this.logger.warn(`Failed to retrieve supporting document: ${error.message}. Continuing without it.`);
                }
            }

            // Create or update domain-specific status maps
            const initialAnalysisStatusMap = { ...(workItem.analysisStatus || {}) };
            const analysisProgressMap = { ...(workItem.analysisProgress || {}) };

            // Set the status for this domain
            initialAnalysisStatusMap[selectedDomain] = 'IN_PROGRESS';
            analysisProgressMap[selectedDomain] = 0;

            await this.storageService.updateWorkItem(userId, fileId, {
                analysisStatus: initialAnalysisStatusMap,
                analysisProgress: analysisProgressMap,
                lastModified: new Date().toISOString(),
            });

            // Get questions from S3 or fallback to domain configuration
            let domainQuestions: DomainQuestion[];

            try {
                // Try to get questions from S3 first
                domainQuestions = await this.questionsService.getQuestionsFromS3(selectedDomain);

                if (domainQuestions.length === 0) {
                    this.logger.warn(`No questions found in S3 for domain ${selectedDomain}, falling back to domain config`);
                    domainQuestions = domainConfig.questions;
                } else {
                    this.logger.log(`Using S3 questions for domain: ${selectedDomain}`);
                }
            } catch (error) {
                this.logger.warn(`Failed to retrieve S3 questions for domain ${selectedDomain}: ${error.message}, falling back to domain config`);
                domainQuestions = domainConfig.questions;
            }

            this.logger.log(`Starting analysis for domain: ${selectedDomain}, domainName: ${domainConfig.name}, questionsCount: ${domainQuestions.length}`);
            this.logger.log(`First few questions: ${domainQuestions.slice(0, 2).map(q => `${q.pillar}: ${q.title}`).join(', ')}`);

            // Calculate total questions
            const totalQuestions = domainQuestions.length;

            // Create a Promise that resolves when cancelAnalysis$ emits
            const cancelPromise = new Promise<boolean>((resolve) => {
                const subscription = this.cancelAnalysis$.subscribe(() => {
                    subscription.unsubscribe();
                    resolve(true);
                });
            });

            // Build flat task list from all questions
            const allTasks: QuestionAnalysisTask[] = domainQuestions.map((question, index) => ({
                question,
                questionIndex: index,
            }));

            // Shared mutable counter for progress tracking across parallel tasks
            const processedCountRef = { value: 0 };

            // Pick batch size based on review type — SMA uses smaller batches due to heavier responses
            const isSMA = selectedDomain === 'saas_maturity_assessment';
            const batchSize = isSMA ? this.SMA_BATCH_SIZE : this.BATCH_SIZE;

            this.logger.log(`Processing ${allTasks.length} questions in batches of ${batchSize} (${isSMA ? 'SMA' : 'standard'} mode)`);

            // Process questions in batches
            for (let batchStart = 0; batchStart < allTasks.length; batchStart += batchSize) {
                // Check for cancellation before each batch
                const isCancelled = await Promise.race([
                    cancelPromise,
                    Promise.resolve(false),
                ]);

                if (isCancelled) {
                    // Update domain-specific status maps
                    const updatedAnalysisStatusMap = { ...(workItem.analysisStatus || {}) };
                    const analysisProgressMap = { ...(workItem.analysisProgress || {}) };
                    const analysisErrorMap = { ...(workItem.analysisError || {}) };
                    const analysisPartialResultsMap = { ...(workItem.analysisPartialResults || {}) };

                    updatedAnalysisStatusMap[selectedDomain] = 'PARTIAL';
                    analysisProgressMap[selectedDomain] = Math.round((processedCountRef.value / totalQuestions) * 100);
                    analysisErrorMap[selectedDomain] = 'Analysis cancelled by user.';
                    analysisPartialResultsMap[selectedDomain] = true;

                    if (workItem && results.length > 0) {
                        try {
                            await this.storageService.storeAnalysisResults(
                                userId,
                                workItem.fileId,
                                results,
                                selectedDomain
                            );
                        } catch (storageError) {
                            this.logger.warn(`Failed to store partial analysis results on cancellation: ${storageError.message}`);
                        }

                        const usedLenses = workItem.usedLenses || [];
                        if (!usedLenses.some(lens => lens.lensAlias === selectedDomain)) {
                            usedLenses.push({
                                lensAlias: selectedDomain,
                                lensName: this.getLensNameFromAlias(selectedDomain),
                                lensAliasArn: selectedDomain
                            });
                        }

                        await this.storageService.updateWorkItem(userId, workItem.fileId, {
                            analysisStatus: updatedAnalysisStatusMap,
                            analysisProgress: analysisProgressMap,
                            analysisError: analysisErrorMap,
                            analysisPartialResults: analysisPartialResultsMap,
                            usedLenses: usedLenses,
                            lastModified: new Date().toISOString(),
                        });
                    }

                    this.analyzerGateway.emitAnalysisProgress({
                        processedQuestions: processedCountRef.value,
                        totalQuestions,
                        currentPillar: allTasks[batchStart].question.pillar,
                        currentQuestion: 'Analysis cancelled',
                        currentCategory: (allTasks[batchStart].question as any).category,
                    });
                    return { results, isCancelled: true, fileId: workItem?.fileId };
                }

                const batchEnd = Math.min(batchStart + batchSize, allTasks.length);
                const batchTasks = allTasks.slice(batchStart, batchEnd);

                this.logger.log(
                    `Processing batch ${Math.floor(batchStart / batchSize) + 1}` +
                    `/${Math.ceil(allTasks.length / batchSize)}: ` +
                    `questions ${batchStart + 1}-${batchEnd} of ${allTasks.length}`
                );

                try {
                    const batchResults = await this.processBatch(
                        batchTasks,
                        fileContent,
                        fileType,
                        uploadMode,
                        supportingDocContent,
                        supportingDocType,
                        supportingDocName,
                        supportingDocumentDescription,
                        domainConfig,
                        currentOutputLanguage,
                        totalQuestions,
                        processedCountRef,
                    );

                    for (const analysis of batchResults) {
                        this.logger.log(`Analysis result created: pillar=${analysis.pillar}, question=${analysis.question}, bestPracticesCount=${analysis.bestPractices?.length || 0}`);
                        results.push(analysis);
                    }
                    this.logger.log(`Total results so far: ${results.length}`);

                    // Update work item progress after batch
                    if (workItem) {
                        const progress = Math.round((processedCountRef.value / totalQuestions) * 100);
                        const analysisProgressMap = { ...(workItem.analysisProgress || {}) };
                        analysisProgressMap[selectedDomain] = progress;

                        await this.storageService.updateWorkItem(userId, workItem.fileId, {
                            analysisProgress: analysisProgressMap,
                            lastModified: new Date().toISOString(),
                        });
                    }
                } catch (error) {
                    // A question in this batch failed — store partial results
                    if (workItem && results.length > 0) {
                        try {
                            await this.storageService.storeAnalysisResults(
                                userId,
                                workItem.fileId,
                                results,
                                selectedDomain
                            );
                        } catch (storageError) {
                            this.logger.warn(`Failed to store partial analysis results on error: ${storageError.message}`);
                        }

                        const progress = Math.round((processedCountRef.value / totalQuestions) * 100);
                        const analysisProgressMap = { ...(workItem.analysisProgress || {}) };
                        const analysisStatusMap = { ...(workItem.analysisStatus || {}) };
                        const analysisErrorMap = { ...(workItem.analysisError || {}) };
                        const analysisPartialResultsMap = { ...(workItem.analysisPartialResults || {}) };

                        analysisProgressMap[selectedDomain] = progress;
                        analysisStatusMap[selectedDomain] = 'PARTIAL';
                        analysisErrorMap[selectedDomain] = `${error.message || error}. Analysis stopped at batch ${Math.floor(batchStart / batchSize) + 1}, ${processedCountRef.value} questions analyzed out of ${totalQuestions}.`;
                        analysisPartialResultsMap[selectedDomain] = true;

                        await this.storageService.updateWorkItem(userId, workItem.fileId, {
                            analysisStatus: analysisStatusMap,
                            analysisProgress: analysisProgressMap,
                            analysisError: analysisErrorMap,
                            analysisPartialResults: analysisPartialResultsMap,
                            lastModified: new Date().toISOString(),
                        });
                    }
                    return {
                        results,
                        isCancelled: false,
                        error: `${error.message || error}. Analysis stopped at batch ${Math.floor(batchStart / batchSize) + 1}, ${processedCountRef.value} questions analyzed out of ${totalQuestions}.`,
                        fileId: workItem?.fileId
                    };
                }
            }

            // Update domain-specific completed status
            const completeAnalysisStatusMap = { ...(workItem.analysisStatus || {}) };
            completeAnalysisStatusMap[selectedDomain] = 'COMPLETED';

            const completeAnalysisProgressMap = { ...(workItem.analysisProgress || {}) };
            completeAnalysisProgressMap[selectedDomain] = 100;

            const completeAnalysisErrorMap = { ...(workItem.analysisError || {}) };
            completeAnalysisErrorMap[selectedDomain] = ''; // Set clear error message on successful completion

            const completeAnalysisPartialResultsMap = { ...(workItem.analysisPartialResults || {}) };
            completeAnalysisPartialResultsMap[selectedDomain] = false;

            // Store final results for this domain
            this.logger.log(`Analysis completed. Final results count: ${results.length}`);
            this.logger.log(`Final results summary: ${results.map((r, i) => `${i + 1}. ${r.pillar}: ${r.question}`).join(', ')}`);

            await this.storageService.storeAnalysisResults(
                userId,
                fileId,
                results,
                selectedDomain
            );

            // Update usedLenses to include the current domain
            const usedLenses = workItem.usedLenses || [];
            if (!usedLenses.some(lens => lens.lensAlias === selectedDomain)) {
                usedLenses.push({
                    lensAlias: selectedDomain,
                    lensName: this.getLensNameFromAlias(selectedDomain),
                    lensAliasArn: selectedDomain // For now, use the alias as ARN
                });
            }

            await this.storageService.updateWorkItem(userId, fileId, {
                analysisStatus: completeAnalysisStatusMap,
                analysisProgress: completeAnalysisProgressMap,
                analysisError: completeAnalysisErrorMap,
                analysisPartialResults: completeAnalysisPartialResultsMap,
                usedLenses: usedLenses,
                lastModified: new Date().toISOString(),
            });

            return { results, isCancelled: false, fileId: workItem.fileId };
        } catch (error) {
            // Store partial results if available before marking as failed
            if (workItem && results.length > 0) {
                // Update domain-specific error status
                const analysisStatusMap = { ...(workItem.analysisStatus || {}) };
                const analysisErrorMap = { ...(workItem.analysisError || {}) };
                const analysisPartialResultsMap = { ...(workItem.analysisPartialResults || {}) };

                analysisStatusMap[selectedDomain] = 'PARTIAL';
                analysisErrorMap[selectedDomain] = error.message || 'Error during analysis';
                analysisPartialResultsMap[selectedDomain] = true;

                try {
                    await this.storageService.storeAnalysisResults(
                        userId,
                        fileId,
                        results,
                        selectedDomain
                    );
                } catch (storageError) {
                    this.logger.warn(`Failed to store partial analysis results on error: ${storageError.message}`);
                    // Continue with status update even if storage fails
                }

                // Update usedLenses to include the current domain
                const usedLenses = workItem.usedLenses || [];
                if (!usedLenses.some(lens => lens.lensAlias === selectedDomain)) {
                    usedLenses.push({
                        lensAlias: selectedDomain,
                        lensName: this.getLensNameFromAlias(selectedDomain),
                        lensAliasArn: selectedDomain
                    });
                }

                await this.storageService.updateWorkItem(userId, fileId, {
                    analysisStatus: analysisStatusMap,
                    analysisError: analysisErrorMap,
                    analysisPartialResults: analysisPartialResultsMap,
                    usedLenses: usedLenses,
                    lastModified: new Date().toISOString(),
                });
            }
            throw error;
        }
    }

    cancelIaCGeneration() {
        this.cancelGeneration$.next();
    }

    async generateIacDocument(
        fileId: string,
        recommendations: any[],
        templateType: IaCTemplateType,
        userId?: string,
        domain?: string,
        outputLanguage?: string
    ): Promise<{ content: string; isCancelled: boolean; error?: string }> {
        try {
            if (!userId) {
                throw new Error('User ID is required for IaC generation');
            }

            // Get file content from storage
            const { content: fileContent, type: fileType } = await this.getFileContent(userId, fileId);
            const workItem = await this.storageService.getWorkItem(userId, fileId);

            if (!fileType.startsWith('image/')) {
                throw new Error('This operation is only supported for architecture diagrams');
            }

            // Use provided domain or default
            const currentDomain = domain || 'saas_resilience';
            const domainConfig = getDomainConfig(currentDomain);
            const currentDomainName = domainConfig?.name || 'Analysis Domain';

            // Update domain-specific IaC generation status
            const iacGenerationStatusMap = { ...(workItem.iacGenerationStatus || {}) };
            const iacGenerationProgressMap = { ...(workItem.iacGenerationProgress || {}) };

            iacGenerationStatusMap[currentDomain] = 'IN_PROGRESS';
            iacGenerationProgressMap[currentDomain] = 0;

            await this.storageService.updateWorkItem(userId, fileId, {
                iacGenerationStatus: iacGenerationStatusMap,
                iacGenerationProgress: iacGenerationProgressMap,
                lastModified: new Date().toISOString(),
            });

            let isComplete = false;
            let allSections: DocumentSection[] = [];
            let iteration = 0;

            // Ensure fileContent is in the correct base64 format
            const processedContent = this.ensureBase64Format(fileContent, fileType);

            // Extract base64 data and media type
            const base64Data = fileContent.split(',')[1];
            const mediaType = fileContent.split(';')[0].split(':')[1];

            while (!isComplete) {
                try {
                    const progress = Math.min(iteration * 10, 90);
                    this.analyzerGateway.emitImplementationProgress({
                        status: `Generating IaC document...`,
                        progress,
                    });

                    // Update domain-specific storage progress
                    const iacGenerationProgressMap = { ...(workItem.iacGenerationProgress || {}) };
                    iacGenerationProgressMap[currentDomain] = progress;

                    await this.storageService.updateWorkItem(userId, fileId, {
                        iacGenerationProgress: iacGenerationProgressMap,
                        lastModified: new Date().toISOString(),
                    });

                    iteration++;

                    const response = await this.invokeBedrockModelForIacGeneration(
                        base64Data,
                        mediaType,
                        recommendations,
                        allSections.length,
                        allSections.length > 0 ? `${JSON.stringify(allSections, null, 2)}` : 'No previous sections generated yet',
                        templateType,
                        null,
                        null,
                        null,
                        null,
                        currentDomainName,
                        outputLanguage || this.outputLanguage
                    );

                    // Handle cancellation and storage updates
                    if (response.isCancelled) {
                        const sortedSections = allSections.sort((a, b) => a.order - b.order);
                        const cancellationNote = '# Note: Template generation was cancelled. Below is a partial version.\n\n';
                        const partialContent = cancellationNote + sortedSections.map(section =>
                            `# ${section.description}\n${section.content}`
                        ).join('\n\n');

                        if (allSections.length > 0) {
                            const extension = templateType.includes('yaml') ? 'yaml' :
                                templateType.includes('json') ? 'json' : 'tf';

                            // Store partial content with lens alias
                            await this.storageService.storeIaCDocument(
                                userId,
                                fileId,
                                partialContent,
                                extension,
                                templateType,
                                currentDomain
                            );

                            // Update lens-specific IaC generation status
                            const progress = Math.min(Math.round((allSections.length / 10) * 100), 90)
                            const iacGenerationStatusMap = { ...(workItem.iacGenerationStatus || {}) };
                            const iacGenerationErrorMap = { ...(workItem.iacGenerationError || {}) };
                            const iacPartialResultsMap = { ...(workItem.iacPartialResults || {}) };
                            const iacGenerationProgressMap = { ...(workItem.iacGenerationProgress || {}) };


                            iacGenerationStatusMap[currentDomain] = 'PARTIAL';
                            iacGenerationErrorMap[currentDomain] = 'Generation cancelled by user';
                            iacPartialResultsMap[currentDomain] = true;
                            iacGenerationProgressMap[currentDomain] = progress;

                            await this.storageService.updateWorkItem(userId, fileId, {
                                iacGenerationStatus: iacGenerationStatusMap,
                                iacGenerationProgress: iacGenerationProgressMap,
                                iacGenerationError: iacGenerationErrorMap,
                                iacPartialResults: iacPartialResultsMap,
                                lastModified: new Date().toISOString(),
                            });
                        }

                        return {
                            content: partialContent || '',
                            isCancelled: true,
                        };
                    }

                    const { isComplete: batchComplete, sections } = this.parseImplementationModelResponse(response.content);
                    allSections.push(...sections);
                    isComplete = batchComplete;

                    // If we have sections but encounter an error, save partial results
                    if (!isComplete && allSections.length > 0) {
                        const sortedSections = allSections.sort((a, b) => a.order - b.order);
                        const partialContent = sortedSections.map(section =>
                            `# ${section.description}\n${section.content}`
                        ).join('\n\n');

                        const extension = templateType.includes('yaml') ? 'yaml' :
                            templateType.includes('json') ? 'json' : 'tf';

                        await this.storageService.storeIaCDocument(
                            userId,
                            fileId,
                            partialContent,
                            extension,
                            templateType,
                            currentDomain
                        );
                    }

                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    // Handle error and save partial results if available
                    if (allSections.length > 0) {
                        const sortedSections = allSections.sort((a, b) => a.order - b.order);
                        const errorNote = '# Note: Template generation encountered an error. Below is a partial version.\n\n';
                        const partialContent = errorNote + sortedSections.map(section =>
                            `# ${section.description}\n${section.content}`
                        ).join('\n\n');

                        const extension = templateType.includes('yaml') ? 'yaml' :
                            templateType.includes('json') ? 'json' : 'tf';

                        // Store partial content with domain
                        await this.storageService.storeIaCDocument(
                            userId,
                            fileId,
                            partialContent,
                            extension,
                            templateType,
                            currentDomain
                        );

                        // Update lens-specific error status
                        const progress = Math.min(Math.round((allSections.length / 10) * 100), 90)
                        const iacGenerationStatusMap = { ...(workItem.iacGenerationStatus || {}) };
                        const iacGenerationErrorMap = { ...(workItem.iacGenerationError || {}) };
                        const iacPartialResultsMap = { ...(workItem.iacPartialResults || {}) };
                        const iacGenerationProgressMap = { ...(workItem.iacGenerationProgress || {}) };

                        iacGenerationStatusMap[currentDomain] = 'PARTIAL';
                        iacGenerationErrorMap[currentDomain] = error.message || 'Error during IaC generation';
                        iacPartialResultsMap[currentDomain] = true;
                        iacGenerationProgressMap[currentDomain] = progress;

                        await this.storageService.updateWorkItem(userId, fileId, {
                            iacGenerationStatus: iacGenerationStatusMap,
                            iacGenerationProgress: iacGenerationProgressMap,
                            iacGenerationError: iacGenerationErrorMap,
                            iacPartialResults: iacPartialResultsMap,
                            lastModified: new Date().toISOString(),
                        });

                        return {
                            content: partialContent,
                            isCancelled: false,
                            error: `Template generation encountered an error. Showing partial results. ${error}`
                        };
                    }
                    throw error;
                }
            }

            this.analyzerGateway.emitImplementationProgress({
                status: 'Finalizing IaC document...',
                progress: 100
            });

            const sortedSections = allSections.sort((a, b) => a.order - b.order);
            const content = sortedSections.map(section =>
                `# ${section.description}\n${section.content}`
            ).join('\n\n');

            // Store final results with lens alias
            const extension = templateType.includes('yaml') ? 'yaml' :
                templateType.includes('json') ? 'json' : 'tf';

            await this.storageService.storeIaCDocument(
                userId,
                fileId,
                content,
                extension,
                templateType,
                currentDomain
            );

            // Update lens-specific completed status
            const finalIacGenerationStatusMap = { ...(workItem.iacGenerationStatus || {}) };
            const finalIacGenerationProgressMap = { ...(workItem.iacGenerationProgress || {}) };
            finalIacGenerationStatusMap[currentDomain] = 'COMPLETED';
            finalIacGenerationProgressMap[currentDomain] = 100;

            const finalIacGenerationErrorMap = { ...(workItem.iacGenerationError || {}) };
            finalIacGenerationErrorMap[currentDomain] = ''; // Set clear error message on successful completion

            const finalIacPartialResultsMap = { ...(workItem.iacPartialResults || {}) };
            finalIacPartialResultsMap[currentDomain] = false;

            await this.storageService.updateWorkItem(userId, fileId, {
                iacGenerationStatus: finalIacGenerationStatusMap,
                iacGenerationProgress: finalIacGenerationProgressMap,
                iacGenerationError: finalIacGenerationErrorMap,
                iacPartialResults: finalIacPartialResultsMap,
                lastModified: new Date().toISOString(),
            });

            return {
                content,
                isCancelled: false
            };
        } catch (error) {
            this.logger.error('Error generating IaC document:', error);
            const currentDomainForIac = domain || 'saas_resilience';
            if (userId && fileId) {
                // Update domain-specific error status
                const workItem = await this.storageService.getWorkItem(userId, fileId);
                const iacGenerationStatusMap = { ...(workItem.iacGenerationStatus || {}) };
                const iacGenerationErrorMap = { ...(workItem.iacGenerationError || {}) };

                iacGenerationStatusMap[currentDomainForIac] = 'FAILED';
                iacGenerationErrorMap[currentDomainForIac] = error.message || 'Error during IaC generation';

                await this.storageService.updateWorkItem(userId, fileId, {
                    iacGenerationStatus: iacGenerationStatusMap,
                    iacGenerationError: iacGenerationErrorMap,
                    lastModified: new Date().toISOString(),
                });
            }
            throw new Error('Failed to generate IaC document');
        }
    }

    private parseImplementationModelResponse(content: string): ModelSectionResponse {
        const isComplete = content.includes('<end_of_iac_document_generation>');
        const cleanContent = content.replace('<end_of_iac_document_generation>', '').trim();

        // Split content into sections based on comments
        const sectionMatches = cleanContent.match(/#\s*Section\s*\d+.*?(?=#\s*Section|\s*$)/gs) || [];

        const sections: DocumentSection[] = sectionMatches.map(section => {
            const orderMatch = section.match(/^#\s*Section\s*(\d+)/);
            const descriptionMatch = section.match(/^#\s*Section\s*\d+\s*-\s*(.+?)\n/);
            const cleanedContent = section
                .replace(/^#\s*Section\s*\d+.*?\n/, '') // Remove section header
                .replace(/<message_truncated>\s*$/, '') // Remove <message_truncated> flag
                .trim();

            return {
                content: cleanedContent,
                order: orderMatch ? parseInt(orderMatch[1]) : 999,
                description: descriptionMatch ? descriptionMatch[1].trim() : 'Unnamed Section'
            };
        });

        return {
            isComplete,
            sections
        };
    }

    async getMoreDetails(
        selectedItems: any[],
        userId: string,
        fileId: string,
        templateType?: IaCTemplateType,
        domain?: string,
        outputLanguage?: string
    ): Promise<{ content: string; error?: string }> {
        this.logger.log(`getMoreDetails called with ${selectedItems.length} selected items`);
        this.logger.log(`Selected items structure: ${JSON.stringify(selectedItems.slice(0, 2), null, 2)}`);
        
        const filteredItems = selectedItems.filter(item => !item.applied && item.relevant === true);
        this.logger.log(`Filtered items count: ${filteredItems.length} (after filtering for !applied && relevant === true)`);
        
        // If no items pass the strict filter, try a more lenient approach
        let itemsToProcess = filteredItems;
        if (filteredItems.length === 0) {
            this.logger.warn('No items found with strict filtering, trying lenient filtering...');
            // Try filtering just for relevant items
            const relevantItems = selectedItems.filter(item => item.relevant !== false);
            if (relevantItems.length > 0) {
                itemsToProcess = relevantItems;
                this.logger.log(`Lenient filtering (relevant !== false) result: ${itemsToProcess.length} items`);
            } else {
                // If even lenient filtering fails, use all selected items
                this.logger.warn('Even lenient filtering found no items, using all selected items...');
                itemsToProcess = selectedItems;
                this.logger.log(`Using all selected items: ${itemsToProcess.length} items`);
            }
        }
        
        try {
            if (!selectedItems || selectedItems.length === 0) {
                throw new Error('No items selected for detailed analysis');
            }

            if (!itemsToProcess || itemsToProcess.length === 0) {
                throw new Error('No items found for detailed analysis after filtering');
            }

            if (!fileId || !userId) {
                throw new Error('File ID and User ID are required');
            }

            // Get file type from work item
            const workItem = await this.storageService.getWorkItem(userId, fileId);
            const fileType = workItem.fileType;

            if (!fileType) {
                throw new Error('No file type provided');
            }

            // Handle PDF files
            if (workItem.uploadMode === FileUploadMode.PDF_FILE) {
                // Get the PDF files
                const { data: pdfFiles } = await this.storageService.getOriginalContent(
                    userId,
                    fileId,
                    false
                );

                // Get supporting document if available
                let supportingDocContent = null;
                let supportingDocType = null;
                let supportingDocName = null;
                let supportingDocDescription = null;

                const usedDomain = domain || 'saas_resilience';

                if (workItem.supportingDocumentId && workItem.supportingDocumentAdded) {
                    try {
                        const supportingDoc = await this.storageService.getSupportingDocument(
                            userId,
                            fileId,
                            workItem.supportingDocumentId[usedDomain],
                            usedDomain
                        );

                        // Convert to base64 for images and PDFs, leave as text for text files
                        if (supportingDoc.contentType === 'text/plain') {
                            supportingDocContent = supportingDoc.data.toString('utf8');
                        } else {
                            supportingDocContent = supportingDoc.data.toString('base64');
                        }

                        supportingDocType = supportingDoc.contentType;
                        supportingDocName = supportingDoc.fileName;
                        supportingDocDescription = workItem.supportingDocumentDescription;
                    } catch (error) {
                        this.logger.warn(`Failed to retrieve supporting document: ${error.message}. Continuing without it.`);
                    }
                }

                let allDetails = '';
                let hasError = false;
                const totalItems = itemsToProcess.length;

                this.analyzerGateway.emitImplementationProgress({
                    status: `Analyzing 1 of ${totalItems} selected items - Item: '${itemsToProcess[0].name || itemsToProcess[0].title || 'Unknown'}'`,
                    progress: 0
                });

                for (let i = 0; i < totalItems; i++) {
                    try {
                        const item = itemsToProcess[i];

                        let itemDetails = '';
                        let isComplete = false;

                        while (!isComplete) {
                            // Create prompt for PDF details
                            const detailsPrompt = Prompts.buildDetailsPrompt(
                                item,
                                "See the provided PDF documents",
                                itemDetails,
                                supportingDocName,
                                supportingDocDescription
                            );

                            // Get system prompt for PDFs
                            const systemPrompt = Prompts.buildPdfDetailsSystemPrompt(usedDomain, outputLanguage || this.outputLanguage);

                            // Invoke model with PDFs
                            const bedrockClient = this.awsConfig.createBedrockClient();
                            const modelId = this.configService.get<string>('aws.bedrock.modelId');
                            const modelParams = this.getModelParameters();

                            // Create message with user prompt
                            const messages: Message[] = [
                                {
                                    role: "user",
                                    content: [
                                        {
                                            text: detailsPrompt
                                        }
                                    ]
                                }
                            ];

                            // Add PDF documents to message content (limit to 5 PDFs)
                            const filesToProcess = Array.isArray(pdfFiles) ? pdfFiles.slice(0, 5) : [];
                            for (const pdfFile of filesToProcess) {
                                messages[0].content.push({
                                    document: {
                                        format: "pdf",
                                        name: this.normalizeFileName(pdfFile.filename),
                                        source: {
                                            bytes: pdfFile.buffer
                                        },
                                        // Adding citations property to enable enhanced PDF visual understanding
                                        citations: {
                                            enabled: true
                                        }
                                    }
                                });
                            }

                            // Add supporting document if available
                            if (supportingDocContent && supportingDocType) {
                                if (supportingDocType === 'text/plain') {
                                    messages[0].content.push({ text: supportingDocContent });
                                } else if (supportingDocType.startsWith('image/')) {
                                    const supportingFormat = supportingDocType.split('/')[1];
                                    messages[0].content.push({
                                        image: {
                                            format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                                            source: { bytes: Buffer.from(supportingDocContent, 'base64') }
                                        }
                                    });
                                } else if (supportingDocType === 'application/pdf') {
                                    messages[0].content.push({
                                        document: {
                                            format: "pdf",
                                            name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                                            source: { bytes: Buffer.from(supportingDocContent, 'base64') },
                                            // Adding citations property to enable enhanced PDF visual understanding
                                            citations: {
                                                enabled: true
                                            }
                                        }
                                    });
                                }
                            }

                            const command = new ConverseCommand({
                                modelId,
                                ...modelParams,
                                messages,
                                system: [{ text: systemPrompt }]
                            });

                            const response = await bedrockClient.send(command);
                            const responseText = response.output.message.content.find(c => c.text)?.text || '';

                            const { content, isComplete: sectionComplete } = this.parseDetailsModelResponse(responseText);
                            itemDetails += content;
                            isComplete = sectionComplete;

                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }

                        // Update progress
                        this.analyzerGateway.emitImplementationProgress({
                            status: `Analyzing ${i + 1} of ${totalItems} selected best practices not applied - Best practice: '${item.name}'`,
                            progress: Math.round(((i + 1) / totalItems) * 100)
                        });

                        allDetails += itemDetails + '\n\n---\n\n';
                    } catch (error) {
                        this.logger.error(`Error analyzing item ${i + 1}:`, error);
                        hasError = true;
                        // Continue with next item instead of stopping completely
                        continue;
                    }
                }

                this.analyzerGateway.emitImplementationProgress({
                    status: 'Analysis complete',
                    progress: 100
                });

                // If we have any details but also encountered errors
                if (allDetails && hasError) {
                    return {
                        content: allDetails,
                        error: 'Some items could not be analyzed. Showing partial results.'
                    };
                }

                // If we have no details at all
                if (!allDetails) {
                    throw new Error('Failed to generate any detailed analysis');
                }

                return { content: allDetails.trim() };
            }

            // Get the file content from storage
            const { data: fileContent } = await this.storageService.getOriginalContent(
                userId,
                fileId,
                false
            );

            // Get supporting document if available
            let supportingDocContent = null;
            let supportingDocType = null;
            let supportingDocName = null;
            let supportingDocDescription = null;

            const usedDomainAlias = domain || 'saas_resilience';

            if (workItem.supportingDocumentId && workItem.supportingDocumentAdded) {
                try {
                    const supportingDoc = await this.storageService.getSupportingDocument(
                        userId,
                        fileId,
                        workItem.supportingDocumentId[usedDomainAlias],
                        usedDomainAlias
                    );

                    // Convert to base64 for images and PDFs, leave as text for text files
                    if (supportingDoc.contentType === 'text/plain') {
                        supportingDocContent = supportingDoc.data.toString('utf8');
                    } else {
                        supportingDocContent = supportingDoc.data.toString('base64');
                    }

                    supportingDocType = supportingDoc.contentType;
                    supportingDocName = supportingDoc.fileName;
                    supportingDocDescription = workItem.supportingDocumentDescription;
                } catch (error) {
                    this.logger.warn(`Failed to retrieve supporting document: ${error.message}. Continuing without it.`);
                }
            }

            // Convert Buffer to string if necessary and ensure proper format
            const processedContent = Buffer.isBuffer(fileContent)
                ? fileType.startsWith('image/')
                    ? `data:${fileType};base64,${fileContent.toString('base64')}`
                    : fileContent.toString('utf-8')
                : typeof fileContent === 'string' && fileType.startsWith('image/') && !fileContent.startsWith('data:')
                    ? `data:${fileType};base64,${fileContent}`
                    : fileContent;

            let allDetails = '';
            let hasError = false;
            const totalItems = itemsToProcess.length;
            const isImage = this.isImageFile(fileType);

            this.analyzerGateway.emitImplementationProgress({
                status: `Analyzing 1 of ${totalItems} selected items - Item: '${itemsToProcess[0].name || itemsToProcess[0].title || 'Unknown'}'`,
                progress: 0
            });

            for (let i = 0; i < totalItems; i++) {
                try {
                    const item = itemsToProcess[i];

                    let itemDetails = '';
                    let isComplete = false;

                    while (!isComplete) {
                        let response;

                        if (isImage) {

                            if (typeof processedContent !== 'string') {
                                throw new Error('Expected string content for image processing');
                            }

                            // Invoke model for image details with supporting doc if available
                            const imageBase64Data = processedContent.split(',')[1];
                            const imageMediaType = processedContent.split(';')[0].split(':')[1];
                            const imageFormat = imageMediaType.split('/')[1]; // Extract format from media type

                            const messages: Message[] = [
                                {
                                    role: "user",
                                    content: [
                                        {
                                            image: {
                                                format: imageFormat as "png" | "jpeg" | "gif" | "webp",
                                                source: {
                                                    bytes: Buffer.from(imageBase64Data, 'base64')
                                                }
                                            }
                                        },
                                        {
                                            text: Prompts.buildImageDetailsPrompt(
                                                item,
                                                itemDetails,
                                                supportingDocName,
                                                supportingDocDescription
                                            )
                                        }
                                    ]
                                }
                            ];

                            // Add supporting document to messages if available
                            if (supportingDocContent && supportingDocType) {
                                if (supportingDocType === 'text/plain') {
                                    // For plain text
                                    messages[0].content.push({
                                        text: supportingDocContent
                                    });
                                } else if (supportingDocType.startsWith('image/')) {
                                    // For images
                                    const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                                    messages[0].content.push({
                                        image: {
                                            format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                                            source: {
                                                bytes: Buffer.from(supportingDocContent, 'base64')
                                            }
                                        }
                                    });
                                } else if (supportingDocType === 'application/pdf') {
                                    // For PDFs
                                    messages[0].content.push({
                                        document: {
                                            format: "pdf",
                                            name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                                            source: {
                                                bytes: Buffer.from(supportingDocContent, 'base64')
                                            },
                                            // Adding citations property to enable enhanced PDF visual understanding
                                            citations: {
                                                enabled: true
                                            }
                                        }
                                    });
                                }
                            }

                            const bedrockClient = this.awsConfig.createBedrockClient();
                            const modelId = this.configService.get<string>('aws.bedrock.modelId');

                            // Get model parameters based on the model type
                            const modelParams = this.getModelParameters();

                            const command = new ConverseCommand({
                                modelId,
                                ...modelParams,
                                messages,
                                system: [
                                    {
                                        text: Prompts.buildImageDetailsSystemPrompt(templateType, modelId, usedDomainAlias, outputLanguage || this.outputLanguage)
                                    }
                                ]
                            });

                            const modelResponse = await bedrockClient.send(command);
                            response = modelResponse;
                        } else {
                            // For non-image files, use the text-based approach with supporting doc if available
                            const detailsPrompt = Prompts.buildDetailsPrompt(
                                item,
                                typeof processedContent === 'string'
                                    ? processedContent
                                    : Array.isArray(processedContent)
                                        ? `PDF files: ${processedContent.map(pdf => pdf.filename).join(', ')}`
                                        : "Content not available as text",
                                itemDetails,
                                supportingDocName,
                                supportingDocDescription
                            );

                            const messages: Message[] = [
                                {
                                    role: "user",
                                    content: [
                                        {
                                            text: detailsPrompt
                                        }
                                    ]
                                }
                            ];

                            // Add supporting document to message content if available
                            if (supportingDocContent && supportingDocType) {
                                if (supportingDocType === 'text/plain') {
                                    // For plain text
                                    messages[0].content.push({
                                        text: supportingDocContent
                                    });
                                } else if (supportingDocType.startsWith('image/')) {
                                    // For images
                                    const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                                    messages[0].content.push({
                                        image: {
                                            format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                                            source: {
                                                bytes: Buffer.from(supportingDocContent, 'base64')
                                            }
                                        }
                                    });
                                } else if (supportingDocType === 'application/pdf') {
                                    // For PDFs
                                    messages[0].content.push({
                                        document: {
                                            format: "pdf",
                                            name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                                            source: {
                                                bytes: Buffer.from(supportingDocContent, 'base64')
                                            },
                                            // Adding citations property to enable enhanced PDF visual understanding
                                            citations: {
                                                enabled: true
                                            }
                                        }
                                    });
                                }
                            }

                            const bedrockClient = this.awsConfig.createBedrockClient();
                            const modelId = this.configService.get<string>('aws.bedrock.modelId');

                            // Get model parameters based on the model type
                            const modelParams = this.getModelParameters();

                            const command = new ConverseCommand({
                                modelId,
                                ...modelParams,
                                messages,
                                system: [
                                    {
                                        text: Prompts.buildDetailsSystemPrompt(modelId, usedDomainAlias, outputLanguage || this.outputLanguage)
                                    }
                                ]
                            });

                            const modelResponse = await bedrockClient.send(command);
                            response = modelResponse;
                        }

                        // Extract text from response output
                        const responseText = response.output.message.content.find(c => c.text)?.text || '';

                        const { content, isComplete: sectionComplete } =
                            this.parseDetailsModelResponse(responseText);

                        itemDetails += content;
                        isComplete = sectionComplete;

                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }

                    // Update progress
                    this.analyzerGateway.emitImplementationProgress({
                        status: `Analyzing ${i + 1} of ${totalItems} selected best practices not applied - Best practice: '${item.name}'`,
                        progress: Math.round(((i + 1) / totalItems) * 100)
                    });

                    allDetails += itemDetails + '\n\n---\n\n';
                } catch (error) {
                    this.logger.error(`Error analyzing item ${i + 1}:`, error);
                    hasError = true;
                    // Continue with next item instead of stopping completely
                    continue;
                }
            }

            this.analyzerGateway.emitImplementationProgress({
                status: 'Analysis complete',
                progress: 100
            });

            // If we have any details but also encountered errors
            if (allDetails && hasError) {
                return {
                    content: allDetails,
                    error: 'Some items could not be analyzed. Showing partial results.'
                };
            }

            // If we have no details at all
            if (!allDetails) {
                throw new Error('Failed to generate any detailed analysis');
            }

            return { content: allDetails.trim() };
        } catch (error) {
            this.logger.error('Error getting more details:', error);
            if (error instanceof Error) {
                throw error;
            }
            throw new Error('Failed to get detailed analysis');
        }
    }

    /**
     * Normalizes file names to comply with Bedrock API requirements:
     * - Only alphanumeric characters, whitespace, hyphens, parentheses, and square brackets
     * - No consecutive whitespace characters
     */
    private normalizeFileName(fileName: string): string {
        if (!fileName) return 'document.pdf';

        // Replace invalid characters with hyphens
        let normalizedName = fileName
            // Keep only allowed characters, replace others with hyphens
            .replace(/[^a-zA-Z0-9\s\-\(\)\[\]]/g, '-')
            // Replace consecutive whitespace with single space
            .replace(/\s+/g, ' ')
            // Trim leading/trailing spaces
            .trim();

        // If empty after normalization, use default name
        return normalizedName || 'document.pdf';
    }

    private parseDetailsModelResponse(content: string): { content: string; isComplete: boolean } {
        const isComplete = content.includes('<end_of_details_generation>');

        // Clean up the content
        let cleanContent = content
            .replace('<end_of_details_generation>', '')
            .replace('<details_truncated>', '')
            .trim();

        // If this isn't the final section, we need to find the last complete section
        if (!isComplete && cleanContent.includes('#')) {
            const sections = cleanContent.split(/(?=# )/);
            // Remove the last potentially incomplete section
            sections.pop();
            cleanContent = sections.join('');
        }

        return {
            content: cleanContent,
            isComplete
        };
    }

    private async retrieveFromKnowledgeBase(
        pillar: string,
        question: string,
        domainQuestion: DomainQuestion,
        domainName?: string
    ): Promise<string[]> {
        const bedrockAgent = this.awsConfig.createBedrockAgentClient();
        const knowledgeBaseId = this.configService.get<string>('aws.bedrock.knowledgeBaseId');
        const modelId = this.configService.get<string>('aws.bedrock.modelId');

        const isSMA = domainName === 'SaaS Maturity Assessment';

        // Filter KB documentation per domain and pillar
        let filter;
        if (isSMA) {
            // SMA: Use SaaS Lens filter (Option 3 — validated by diagnostic testing)
            // No pillar filter — semantic search handles pillar-level matching
            filter = {
                equals: {
                    key: "lens_name",
                    value: "SaaS Lens"
                }
            };
        } else if (domainName) {
            filter = {
                andAll: [
                    {
                        equals: {
                            key: "domain_name",
                            value: domainName
                        }
                    },
                    {
                        equals: {
                            key: "pillar",
                            value: pillar
                        }
                    }
                ]
            };
        } else {
            filter = {
                equals: {
                    key: "pillar",
                    value: pillar
                }
            };
        }

        // SMA uses dedicated KB prompts (clean input, no rating descriptions)
        const inputText = isSMA
            ? Prompts.buildSMAKnowledgeBaseInputPrompt(domainQuestion as SMAQuestion)
            : Prompts.buildKnowledgeBaseInputPrompt(question, pillar, domainQuestion, domainName);

        const promptTemplate = isSMA
            ? Prompts.buildSMAKnowledgeBasePromptTemplate()
            : Prompts.buildKnowledgeBasePromptTemplate(domainName);

        const command = new RetrieveAndGenerateCommand({
            input: {
                text: inputText,
            },
            retrieveAndGenerateConfiguration: {
                type: "KNOWLEDGE_BASE",
                knowledgeBaseConfiguration: {
                    knowledgeBaseId: knowledgeBaseId,
                    modelArn: modelId,
                    retrievalConfiguration: {
                        vectorSearchConfiguration: {
                            numberOfResults: 10,
                            filter: filter
                        },
                    },
                    generationConfiguration: {
                        inferenceConfig: {
                            textInferenceConfig: {
                                maxTokens: 8192,
                                temperature: 0.7
                            }
                        },
                        promptTemplate: {
                            textPromptTemplate: promptTemplate
                        }
                    }
                }
            }
        });

        const response = await bedrockAgent.send(command);

        // Return as an array with one element to match the expected return type
        return response.output?.text ? [response.output.text] : [];
    }

    private async analyzeQuestion(
        fileContent: string | any,
        question: DomainQuestion,
        kbContexts: string[],
        fileType: string,
        uploadMode: FileUploadMode = FileUploadMode.SINGLE_FILE,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string,
        supportingDocDescription?: string,
        domainName?: string,
        domainPillars?: string[],
        outputLanguage: string = 'en' // Add language parameter with English default
    ): Promise<any> {
        try {
            const isSMA = domainName === 'SaaS Maturity Assessment';
            const smaQuestion = isSMA ? question as SMAQuestion : null;

            // Handle PDF files
            if (uploadMode === FileUploadMode.PDF_FILE) {
                // fileContent should be an array of PDF files with filename and buffer
                const pdfFiles = fileContent;

                return await this.analyzePdfFiles(
                    pdfFiles,
                    question,
                    kbContexts,
                    supportingDocContent,
                    supportingDocType,
                    supportingDocName,
                    supportingDocDescription,
                    domainName,
                    domainPillars,
                    outputLanguage
                );
            }

            // Determine if it's an image
            const isImage = uploadMode === FileUploadMode.SINGLE_FILE && fileType.startsWith('image/');

            // Get pillar names as comma-separated string for prompts
            const pillarNames = domainPillars ? domainPillars.join(', ') :
                'Reliability, Performance, Security';

            let prompt: string;
            let systemPrompt: string;

            if (isSMA && smaQuestion) {
                // SMA-specific prompts (3-layer architecture: KB context in user prompt, rating rubric in system prompt)
                prompt = isImage
                    ? Prompts.buildSMAImagePrompt(smaQuestion, kbContexts, supportingDocName, supportingDocDescription)
                    : uploadMode === FileUploadMode.SINGLE_FILE
                        ? Prompts.buildSMAPrompt(smaQuestion, kbContexts, supportingDocName, supportingDocDescription)
                        : Prompts.buildSMAProjectPrompt(smaQuestion, kbContexts, supportingDocName, supportingDocDescription);

                systemPrompt = isImage
                    ? Prompts.buildSMAImageSystemPrompt(smaQuestion, pillarNames, outputLanguage)
                    : uploadMode === FileUploadMode.SINGLE_FILE
                        ? Prompts.buildSMASystemPrompt(fileContent, smaQuestion, pillarNames, outputLanguage)
                        : Prompts.buildSMAProjectSystemPrompt(fileContent, smaQuestion, pillarNames, outputLanguage);
            } else {
                // Standard WAFR/Domain prompts
                prompt = isImage
                    ? Prompts.buildImagePrompt(question, kbContexts, supportingDocName, supportingDocDescription)
                    : uploadMode === FileUploadMode.SINGLE_FILE
                        ? Prompts.buildPrompt(question, kbContexts, supportingDocName, supportingDocDescription)
                        : Prompts.buildProjectPrompt(question, kbContexts, supportingDocName, supportingDocDescription);

                systemPrompt = isImage
                    ? Prompts.buildImageSystemPrompt(question, domainName, pillarNames, {}, outputLanguage)
                    : uploadMode === FileUploadMode.SINGLE_FILE
                        ? Prompts.buildSystemPrompt(fileContent, question, domainName, pillarNames, {}, outputLanguage)
                        : Prompts.buildProjectSystemPrompt(fileContent, question, domainName, pillarNames, {}, outputLanguage);
            }

            // Ensure fileContent is properly formatted for images
            if (isImage && !fileContent.startsWith('data:')) {
                this.logger.error('Invalid image content format');
                throw new Error('Invalid image content format');
            }

            const response = isImage
                ? await this.invokeBedrockModelWithImage(
                    prompt,
                    systemPrompt,
                    fileContent,
                    supportingDocContent,
                    supportingDocType,
                    supportingDocName
                )
                : await this.invokeBedrockModel(
                    prompt,
                    systemPrompt,
                    supportingDocContent,
                    supportingDocType,
                    supportingDocName
                );

            // SMA returns maturity-level assessment, standard returns best practices
            if (isSMA) {
                return this.parseSMAModelResponse(response, question);
            }

            return {
                pillar: question.pillar,
                question: question.title,
                questionId: question.id,
                bestPractices: this.parseModelResponse(response, question),
            };
        } catch (error) {
            this.logger.error('Error analyzing question:', error);
            throw error;
        }
    }

    private cleanJsonString(jsonString: string): string {
        // First trim everything outside the outermost json_response tags
        const startTag = "<json_response>";
        const endTag = "</json_response>";
        const startIndex = jsonString.indexOf(startTag);
        const endIndex = jsonString.lastIndexOf(endTag);

        if (startIndex !== -1 && endIndex !== -1) {
            // Extract content between tags (excluding the tags themselves)
            jsonString = jsonString.substring(startIndex + startTag.length, endIndex);
        }

        // Then trim everything outside the outermost curly braces
        const firstCurlyBrace = jsonString.indexOf('{');
        const lastCurlyBrace = jsonString.lastIndexOf('}');

        if (firstCurlyBrace !== -1 && lastCurlyBrace !== -1) {
            jsonString = jsonString.substring(firstCurlyBrace, lastCurlyBrace + 1);
        }

        // Handle cite tags
        // Replace <cite index="..."> with a blank space
        jsonString = jsonString.replace(/<cite\s+index="[^"]*">/g, " ");

        // Replace </cite>. with just . (strip out </cite> when followed by a period)
        jsonString = jsonString.replace(/<\/cite>\./g, ".");

        // Replace other </cite> instances with ". " (period followed by a space)
        jsonString = jsonString.replace(/<\/cite>/g, ". ");

        // Remove newlines and extra spaces
        jsonString = jsonString.replace(/\s+/g, " ");

        // Remove spaces after colons that are not within quotes
        jsonString = jsonString.replace(/(?<!"):\s+/g, ":");

        // Remove spaces before colons
        jsonString = jsonString.replace(/\s+:/g, ":");

        // Remove spaces after commas that are not within quotes
        jsonString = jsonString.replace(/(?<!"),\s+/g, ",");

        // Remove spaces before commas
        jsonString = jsonString.replace(/\s+,/g, ",");

        // Remove spaces after opening brackets and before closing brackets
        jsonString = jsonString.replace(/{\s+/g, "{");
        jsonString = jsonString.replace(/\s+}/g, "}");
        jsonString = jsonString.replace(/\[\s+/g, "[");
        jsonString = jsonString.replace(/\s+\]/g, "]");

        // Convert Python boolean values to JSON boolean values
        jsonString = jsonString.replace(/: True/g, ": true");
        jsonString = jsonString.replace(/: False/g, ": false");

        return jsonString;
    }

    private async invokeBedrockModelWithImage(
        prompt: string,
        systemPrompt: string,
        imageContent: string,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string
    ): Promise<ModelResponse> {
        const bedrockClient = this.awsConfig.createBedrockClient();
        const modelId = this.configService.get<string>('aws.bedrock.modelId');

        // Get model parameters based on the model type
        const modelParams = this.getModelParameters();

        try {
            // Extract base64 data and media type from data URL
            const matches = imageContent.match(/^data:([^;]+);base64,(.+)$/);
            if (!matches) {
                throw new Error('Invalid image data format');
            }

            const [, imageMediaType, imageBase64Data] = matches;
            const imageFormat = imageMediaType.split('/')[1]; // Extract format from media type (e.g., "png" from "image/png")

            const messages: Message[] = [
                {
                    role: "user", // Using literal "user" as required by the API
                    content: [
                        {
                            image: {
                                format: imageFormat as "png" | "jpeg" | "gif" | "webp",
                                source: {
                                    bytes: Buffer.from(imageBase64Data, 'base64')
                                }
                            }
                        },
                        {
                            text: prompt
                        }
                    ]
                }
            ];

            // Add supporting document to message content if provided
            if (supportingDocContent && supportingDocType) {
                if (supportingDocType === 'text/plain') {
                    // For plain text
                    messages[0].content.push({
                        text: supportingDocContent
                    });
                } else if (supportingDocType.startsWith('image/')) {
                    // For images
                    const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                    messages[0].content.push({
                        image: {
                            format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                            source: {
                                bytes: Buffer.from(supportingDocContent, 'base64')
                            }
                        }
                    });
                } else if (supportingDocType === 'application/pdf') {
                    // For PDFs
                    messages[0].content.push({
                        document: {
                            format: "pdf",
                            name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                            source: {
                                bytes: Buffer.from(supportingDocContent, 'base64')
                            },
                            // Adding citations property to enable enhanced PDF visual understanding
                            citations: {
                                enabled: true
                            }
                        }
                    });
                }
            }

            // Prepare system content
            const system: SystemContentBlock[] = [
                {
                    text: systemPrompt
                }
            ];

            const command = new ConverseCommand({
                modelId,
                ...modelParams,
                messages,
                system
            });

            const response = await bedrockClient.send(command);

            // Extract text from the response
            const responseText = response.output.message.content.find(c => c.text)?.text || '';

            const cleanedAnalysisJsonString = this.cleanJsonString(responseText);
            return JSON.parse(cleanedAnalysisJsonString);
        } catch (error) {
            this.logger.error('Error invoking Bedrock model:', error);
            throw new Error(`Failed to analyze diagram with AI model. Error invoking Bedrock model: ${error}`);
        }
    }

    private async invokeBedrockModel(
        prompt: string,
        systemPrompt: string,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string
    ): Promise<ModelResponse> {
        const bedrockClient = this.awsConfig.createBedrockClient();
        const modelId = this.configService.get<string>('aws.bedrock.modelId');

        // Get model parameters based on the model type
        const modelParams = this.getModelParameters();

        // Prepare base message
        const messages: Message[] = [
            {
                role: "user",
                content: [
                    {
                        text: prompt
                    }
                ]
            }
        ];

        // Add supporting document to message content if provided
        if (supportingDocContent && supportingDocType) {
            if (supportingDocType === 'text/plain') {
                // For plain text
                messages[0].content.push({
                    text: supportingDocContent
                });
            } else if (supportingDocType.startsWith('image/')) {
                // For images
                const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                messages[0].content.push({
                    image: {
                        format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                        source: {
                            bytes: Buffer.from(supportingDocContent, 'base64')
                        }
                    }
                });
            } else if (supportingDocType === 'application/pdf') {
                // For PDFs
                messages[0].content.push({
                    document: {
                        format: "pdf",
                        name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                        source: {
                            bytes: Buffer.from(supportingDocContent, 'base64')
                        },
                        // Adding citations property to enable enhanced PDF visual understanding
                        citations: {
                            enabled: true
                        }
                    }
                });
            }
        }

        try {
            const command = new ConverseCommand({
                modelId,
                ...modelParams,
                messages,
                system: [
                    {
                        text: systemPrompt
                    }
                ]
            });

            const response = await bedrockClient.send(command);

            // Extract text from response
            const responseText = response.output.message.content.find(c => c.text)?.text || '';

            const cleanedAnalysisJsonString = this.cleanJsonString(responseText);
            const parsedAnalysis = JSON.parse(cleanedAnalysisJsonString);

            return parsedAnalysis;
        } catch (error) {
            this.logger.error('Error invoking Bedrock model:', error);
            throw new Error(`Failed to analyze template with AI model. Error invoking Bedrock model: ${error}`);
        }
    }

    async invokeBedrockModelForIacGeneration(
        imageData: string,
        mediaType: string,
        recommendations: any[],
        previousSections: number,
        allPreviousSections: string,
        templateType?: IaCTemplateType,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string,
        supportingDocDescription?: string,
        lensName?: string,
        outputLanguage: string = 'en' // Add language parameter with English default
    ): Promise<{ content: string; isCancelled: boolean }> {
        const bedrockClient = this.awsConfig.createBedrockClient();
        const modelId = this.configService.get<string>('aws.bedrock.modelId');

        // Get model parameters based on the model type
        const modelParams = this.getModelParameters();

        const systemPrompt = Prompts.buildIacGenerationSystemPrompt(templateType, modelId, lensName, outputLanguage);
        const prompt = Prompts.buildIacGenerationPrompt(
            previousSections,
            allPreviousSections,
            recommendations,
            supportingDocName,
            supportingDocDescription
        );

        const imageFormat = mediaType.split('/')[1]; // Extract format from media type

        const messages: Message[] = [
            {
                role: "user",
                content: [
                    {
                        image: {
                            format: imageFormat as "png" | "jpeg" | "gif" | "webp",
                            source: {
                                bytes: Buffer.from(imageData, 'base64')
                            }
                        }
                    },
                    {
                        text: prompt
                    }
                ]
            }
        ];

        // Add supporting document to message content if provided
        if (supportingDocContent && supportingDocType) {
            if (supportingDocType === 'text/plain') {
                // For plain text
                messages[0].content.push({
                    text: supportingDocContent
                });
            } else if (supportingDocType.startsWith('image/')) {
                // For images
                const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                messages[0].content.push({
                    image: {
                        format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                        source: {
                            bytes: Buffer.from(supportingDocContent, 'base64')
                        }
                    }
                });
            } else if (supportingDocType === 'application/pdf') {
                // For PDFs
                messages[0].content.push({
                    document: {
                        format: "pdf",
                        name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                        source: {
                            bytes: Buffer.from(supportingDocContent, 'base64')
                        },
                        // Adding citations property to enable enhanced PDF visual understanding
                        citations: {
                            enabled: true
                        }
                    }
                });
            }
        }

        // Create a Promise that resolves when cancelGeneration$ emits
        const cancelPromise = new Promise<void>((resolve) => {
            const subscription = this.cancelGeneration$.subscribe(() => {
                subscription.unsubscribe();
                resolve();
            });
        });

        try {
            const command = new ConverseCommand({
                modelId,
                ...modelParams,
                messages,
                system: [
                    {
                        text: systemPrompt
                    }
                ]
            });

            // Race between the Bedrock call and cancellation
            const modelResponsePromise = bedrockClient.send(command);
            const raceResult = await Promise.race([
                modelResponsePromise,
                cancelPromise.then(() => null)
            ]);

            if (!raceResult) {
                // Cancelled
                return {
                    content: allPreviousSections,
                    isCancelled: true
                };
            }

            // Not cancelled, process normal response
            const responseText = raceResult.output.message.content.find(c => c.text)?.text || '';

            return {
                content: responseText,
                isCancelled: false
            };
        } catch (error) {
            this.logger.error('Error invoking Bedrock model:', error);
            throw new Error(`Failed to generate IaC document. Error invoking Bedrock model: ${error}`);
        }
    }

    /**
 * Analyzes PDF files against AWS Well-Architected best practices
 * @param pdfFiles Array of PDF files with filename and buffer
 * @param question The question group containing best practices to evaluate
 * @param kbContexts Knowledge base contexts retrieved from Bedrock
 * @param supportingDocContent Supporting document content (if any)
 * @param supportingDocType Supporting document type (if any)
 * @param supportingDocName Supporting document name (if any)
 * @param supportingDocDescription Supporting document description (if any)
 * @param lensName Optional lens name
 * @returns Analysis results
 */
    private async analyzePdfFiles(
        pdfFiles: Array<{ filename: string, buffer: Buffer, size: number }>,
        question: DomainQuestion,
        kbContexts: string[],
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string,
        supportingDocDescription?: string,
        domainName?: string,
        domainPillars?: string[],
        outputLanguage: string = 'en' // Add language parameter with English default
    ): Promise<any> {
        try {
            // Get the prompt
            const prompt = Prompts.buildPrompt(question, kbContexts, supportingDocName, supportingDocDescription);

            // Get system prompt for PDFs with language parameter
            const systemPrompt = Prompts.buildPdfSystemPrompt(question, domainName, pdfFiles.length, {}, outputLanguage);

            // Invoke model with PDF files
            const response = await this.invokeBedrockModelWithPdfs(
                prompt,
                systemPrompt,
                pdfFiles,
                supportingDocContent,
                supportingDocType,
                supportingDocName
            );

            return {
                pillar: question.pillar,
                question: question.title,
                questionId: question.id,
                bestPractices: this.parseModelResponse(response, question),
            };
        } catch (error) {
            this.logger.error('Error analyzing PDF files:', error);
            throw new Error(`Failed to analyze PDF files: ${error.message}`);
        }
    }

    /**
     * Invokes Bedrock model with PDF documents
     * @param prompt The prompt text for analysis
     * @param systemPrompt The system prompt for the model
     * @param pdfFiles Array of PDF files with filename and buffer
     * @param supportingDocContent Supporting document content (if any)
     * @param supportingDocType Supporting document type (if any)
     * @param supportingDocName Supporting document name (if any)
     * @returns The model response
     */
    private async invokeBedrockModelWithPdfs(
        prompt: string,
        systemPrompt: string,
        pdfFiles: Array<{ filename: string, buffer: Buffer, size: number }>,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string
    ): Promise<ModelResponse> {
        const bedrockClient = this.awsConfig.createBedrockClient();
        const modelId = this.configService.get<string>('aws.bedrock.modelId');

        // Get model parameters based on the model type
        const modelParams = this.getModelParameters();

        try {
            // Build message with user prompt
            const messages: Message[] = [
                {
                    role: "user",
                    content: [
                        {
                            text: prompt
                        }
                    ]
                }
            ];

            // Add PDF documents to message content (limit to 5 PDFs as per Bedrock limits)
            const filesToProcess = pdfFiles.slice(0, 5);
            for (const pdfFile of filesToProcess) {
                messages[0].content.push({
                    document: {
                        format: "pdf",
                        name: this.normalizeFileName(pdfFile.filename),
                        source: {
                            bytes: pdfFile.buffer
                        },
                        // Adding citations property to enable enhanced PDF visual understanding
                        citations: {
                            enabled: true
                        }
                    }
                });
            }

            // Add supporting document if provided
            if (supportingDocContent && supportingDocType) {
                if (supportingDocType === 'text/plain') {
                    // For plain text
                    messages[0].content.push({
                        text: supportingDocContent
                    });
                } else if (supportingDocType.startsWith('image/')) {
                    // For images
                    const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                    messages[0].content.push({
                        image: {
                            format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                            source: {
                                bytes: Buffer.from(supportingDocContent, 'base64')
                            }
                        }
                    });
                } else if (supportingDocType === 'application/pdf') {
                    // For PDF supporting document
                    messages[0].content.push({
                        document: {
                            format: "pdf",
                            name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                            source: {
                                bytes: Buffer.from(supportingDocContent, 'base64')
                            },
                            // Adding citations property to enable enhanced PDF visual understanding
                            citations: {
                                enabled: true
                            }
                        }
                    });
                }
            }

            const command = new ConverseCommand({
                modelId,
                ...modelParams,
                messages,
                system: [{ text: systemPrompt }]
            });

            const response = await bedrockClient.send(command);

            // Extract text from response
            const responseText = response.output.message.content.find(c => c.text)?.text || '';

            const cleanedAnalysisJsonString = this.cleanJsonString(responseText);
            return JSON.parse(cleanedAnalysisJsonString);
        } catch (error) {
            this.logger.error('Error invoking Bedrock model with PDFs:', error);
            throw new Error(`Failed to analyze PDF documents with AI model. Error invoking Bedrock model: ${error}`);
        }
    }

    private parseModelResponse(response: ModelResponse, domainQuestion: DomainQuestion): any[] {
        try {
            return response.bestPractices.map((bp: BestPractice, index: number) => ({
                id: domainQuestion.bestPractices[index]?.id || `${domainQuestion.id}_bp_${index}`,
                name: bp.name,
                relevant: bp.relevant,
                applied: bp.applied,
                reasonApplied: bp.reasonApplied,
                reasonNotApplied: bp.reasonNotApplied,
                recommendations: bp.recommendations,
                extendedRecommendations: bp.extendedRecommendations,
            }));
        } catch (error) {
            this.logger.error('Error parsing model response:', error);
            throw new Error('Failed to parse analysis results');
        }
    }

    /**
     * Parses the SMA model response (maturity-level JSON) into the analysis result structure.
     * SMA returns a single assessment per question with maturity level (1-5), not a bestPractices array.
     */
    private parseSMAModelResponse(response: any, question: DomainQuestion): any {
        try {
            return {
                pillar: response.pillar || question.pillar,
                question: response.question || question.title,
                questionId: response.questionId || question.id,
                category: response.category || question.category,
                maturityLevel: response.maturityLevel,
                confidence: response.confidence,
                iacEvidence: response.iacEvidence,
                maturityJustification: response.maturityJustification,
                processAssessmentNote: response.processAssessmentNote,
                recommendations: response.recommendations,
                relevantResources: response.relevantResources || [],
                // Map to bestPractices array for frontend compatibility
                bestPractices: [{
                    id: `${question.id}_maturity`,
                    name: question.title,
                    relevant: true,
                    applied: response.maturityLevel !== null && response.maturityLevel >= 3,
                    reasonApplied: response.maturityLevel >= 3 ? response.iacEvidence : null,
                    reasonNotApplied: response.maturityLevel !== null && response.maturityLevel < 3 ? response.iacEvidence : null,
                    recommendations: response.recommendations,
                }],
            };
        } catch (error) {
            this.logger.error('Error parsing SMA model response:', error);
            throw new Error('Failed to parse SMA assessment results');
        }
    }

    private async loadWellArchitectedAnswers(workloadId: string, lensAlias?: string): Promise<WellArchitectedAnswer> {
        const waClient = this.awsConfig.createWAClient();

        try {
            const allAnswers: WellArchitectedAnswer = {
                AnswerSummaries: [],
                WorkloadId: workloadId,
            };

            // Use the provided lens alias or default to wellarchitected
            const usedLensAlias = lensAlias || 'wellarchitected';

            const paginator = paginateListAnswers(
                { client: waClient },
                {
                    WorkloadId: workloadId,
                    LensAlias: usedLensAlias
                }
            );

            // Iterate through all pages
            for await (const page of paginator) {
                if (page.AnswerSummaries) {
                    allAnswers.AnswerSummaries.push(...page.AnswerSummaries);
                }

                // Set LensAlias and LensArn from the page response
                if (page.LensAlias) {
                    allAnswers.LensAlias = page.LensAlias;
                }
                if (page.LensArn) {
                    allAnswers.LensArn = page.LensArn;
                }
            }

            return allAnswers;
        } catch (error) {
            this.logger.error('Error fetching Well-Architected answers:', error);
            throw new Error('Failed to fetch Well-Architected answers');
        }
    }

    // Load best practices once
    private async loadBestPractices(workloadId: string, lensAliasArn: string, lensPillars: Record<string, string>): Promise<WellArchitectedBestPractice[]> {

        const s3Client = this.awsConfig.createS3Client();
        const waDocsBucket = this.configService.get<string>('aws.s3.waDocsBucket');

        try {
            // Extract the lens name from the lens alias (everything after the last slash)
            let lensName = 'wellarchitected';
            if (lensAliasArn) {
                lensName = lensAliasArn.split('/').pop() || 'wellarchitected';
            }

            // Create the path to the best practices JSON file
            const bestPracticesPath = `${lensName}/best_practices_list/${lensName}_best_practices.json`;

            // Fetch best practices from S3
            const s3Response = await s3Client.send(
                new GetObjectCommand({
                    Bucket: waDocsBucket,
                    Key: bestPracticesPath
                })
            );

            const responseBody = await s3Response.Body?.transformToString();
            if (!responseBody) {
                throw new Error('No data received from S3');
            }

            const baseBestPractices: WellArchitectedBestPractice[] = JSON.parse(responseBody);

            // Fetch WA Tool answers
            const waAnswers = await this.loadWellArchitectedAnswers(workloadId, lensAliasArn);

            // Create mappings for both ChoiceIds and QuestionIds
            const choiceIdMapping = new Map<string, string>();
            const questionIdMapping = new Map<string, string>();

            waAnswers.AnswerSummaries.forEach(answer => {
                // Map QuestionId to Question Title
                questionIdMapping.set(answer.QuestionTitle, answer.QuestionId);

                // Map Choice Titles to ChoiceIds
                answer.Choices?.forEach(choice => {
                    if (choice.Title && choice.ChoiceId) {
                        // Create a unique key combining question and choice (for cases of WA questions with same BP title)
                        const uniqueKey = `${answer.QuestionTitle}|||${choice.Title}`;
                        choiceIdMapping.set(uniqueKey, choice.ChoiceId);
                    }
                });
            });

            // Create the reverse mapping (from pillar name to ID)
            const reversePillarMapping = {};
            Object.entries(lensPillars).forEach(([id, name]) => {
                reversePillarMapping[name] = id;
            });

            // Enhance best practices with their corresponding ChoiceIds and QuestionIds
            this.cachedBestPractices = baseBestPractices.map(bp => {
                // Create the same unique key for lookup
                const uniqueKey = `${bp.Question}|||${bp['Best Practice']}`;

                const pillarId = reversePillarMapping[bp.Pillar];

                return {
                    ...bp,
                    bestPracticeId: choiceIdMapping.get(uniqueKey) ||
                        this.generateFallbackBestPracticeId(`${bp.Question}-${bp['Best Practice']}`),
                    questionId: questionIdMapping.get(bp.Question) ||
                        this.generateFallbackBestPracticeId(bp.Question),
                    pillarId: pillarId
                };
            });

            return this.cachedBestPractices;
        } catch (error) {
            this.logger.error('Error loading best practices:', error);
            throw new Error('Failed to load Well-Architected best practices');
        }
    }

    private async retrieveBestPractices(pillarId: string, workloadId: string, lensAliasArn?: string, lensPillars?: Record<string, string>): Promise<QuestionGroup[]> {
        try {
            const allBestPractices = await this.loadBestPractices(workloadId, lensAliasArn, lensPillars);
            const pillarBestPractices = allBestPractices.filter(
                bp => bp.pillarId === pillarId
            );

            const questionGroups = new Map<string, {
                practices: Array<{ practice: string, id: string }>,
                questionId: string
            }>();

            pillarBestPractices.forEach(bp => {
                if (!questionGroups.has(bp.Question)) {
                    questionGroups.set(bp.Question, {
                        practices: [],
                        questionId: bp.questionId
                    });
                }
                questionGroups.get(bp.Question)?.practices.push({
                    practice: bp['Best Practice'],
                    id: bp.bestPracticeId
                });
            });

            return Array.from(questionGroups.entries()).map(([question, data]) => ({
                pillar: pillarBestPractices[0].Pillar,
                title: question,
                questionId: data.questionId,
                bestPractices: data.practices.map(p => p.practice),
                bestPracticeIds: data.practices.map(p => p.id)
            }));
        } catch (error) {
            this.logger.error('Error retrieving best practices:', error);
            throw new Error('Failed to retrieve Well-Architected best practices');
        }
    }

    private generateFallbackBestPracticeId(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }
}