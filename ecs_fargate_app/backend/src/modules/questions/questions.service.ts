import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AwsConfigService } from '../../config/aws.config';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { DomainQuestion } from '../../config/domain.config';

interface S3Question {
  Pillar: string;
  Question: string;
  'Best Practice': string;
  /** SMA-specific fields (optional — only present in sma_questions.json) */
  Id?: string;
  Category?: string;
  Ratings?: {
    level1: string;
    level2: string;
    level3: string;
    level4: string;
    level5: string;
  };
}

@Injectable()
export class QuestionsService {
  private readonly logger = new Logger(QuestionsService.name);

  constructor(
    private readonly awsConfig: AwsConfigService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Retrieve questions from S3 for a specific domain
   * @param domain The domain identifier (e.g., 'saas_resilience')
   * @returns Array of domain questions in the expected format
   */
  async getQuestionsFromS3(domain: string): Promise<DomainQuestion[]> {
    const s3Client = this.awsConfig.createS3Client();
    const bucket = this.configService.get<string>('storage.bucket'); // Use the same bucket as storage
    
    // Map domains to their respective JSON files in the Analysis Storage bucket
    const domainFileMap: Record<string, string> = {
      'saas_resilience': 'saas_best_practices.json',
      'data_resilience': 'data_resilience_best_practices.json',
      'eks_resilience': 'eks_resilience_best_practices.json',
      'network_resilience': 'network_resilience_best_practices.json',
      'saas_maturity_assessment': 'sma_questions.json',
    };
    
    const key = domainFileMap[domain];
    if (!key) {
      throw new Error(`No S3 questions file configured for domain: ${domain}`);
    }

    this.logger.log(`Retrieving questions from S3: domain=${domain}, bucket=${bucket}, key=${key}`);

    try {
      const result = await s3Client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );

      const content = await result.Body.transformToString();
      const s3Questions: S3Question[] = JSON.parse(content);

      this.logger.log(`Retrieved ${s3Questions.length} questions from S3`);

      // Transform S3 format to domain question format
      const domainQuestions: DomainQuestion[] = s3Questions.map((q, index) => ({
        id: q.Id || `${domain}_${index + 1}`,
        title: q.Question,
        pillar: q.Pillar,
        bestPractices: q['Best Practice']
          ? [{ id: `${domain}_${index + 1}_bp1`, name: q['Best Practice'], description: q['Best Practice'] }]
          : [],
        ...(q.Category && { category: q.Category }),
        ...(q.Ratings && { ratings: q.Ratings }),
      }));

      this.logger.log(`Transformed questions: ${domainQuestions.map(q => `${q.pillar}: ${q.title}`).slice(0, 3).join(', ')}${domainQuestions.length > 3 ? '...' : ''}`);

      return domainQuestions;
    } catch (error) {
      this.logger.error(`Error retrieving questions from S3: ${error.message}`);
      
      // Fallback to empty array or throw error based on your preference
      if (error.name === 'NoSuchKey') {
        this.logger.warn(`Questions file not found in S3: ${key}. Using empty questions array.`);
        return [];
      }
      
      throw new Error(`Failed to retrieve questions from S3: ${error.message}`);
    }
  }

  /**
   * Check if S3 questions are available for a domain
   * @param domain The domain identifier
   * @returns True if questions exist in S3, false otherwise
   */
  async hasS3Questions(domain: string): Promise<boolean> {
    try {
      const questions = await this.getQuestionsFromS3(domain);
      return questions.length > 0;
    } catch (error) {
      this.logger.warn(`S3 questions not available for domain ${domain}: ${error.message}`);
      return false;
    }
  }
}