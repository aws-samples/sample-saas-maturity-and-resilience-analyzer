import { IsString, IsArray, IsNotEmpty, IsOptional, IsBoolean, MaxLength, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

// --- Well-Architected Controller DTOs ---

export class RiskSummaryDto {
  @IsString()
  @IsNotEmpty()
  workloadId: string;

  @IsString()
  @IsOptional()
  lensAliasArn?: string;
}

export class UpdateAnswerDto {
  @IsString()
  @IsNotEmpty()
  questionId: string;

  @IsArray()
  @IsString({ each: true })
  selectedChoices: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  notApplicableChoices?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  notSelectedChoices?: string[];

  @IsString()
  @IsOptional()
  lensAliasArn?: string;
}

export class AssociateLensDto {
  @IsString()
  @IsNotEmpty()
  lensAliasArn: string;
}

export class CreateWorkloadDto {
  @IsBoolean()
  isTemp: boolean;

  @IsString()
  @IsOptional()
  lensAliasArn?: string;
}

// --- Analyzer Controller DTOs ---

export class GenerateIacDto {
  @IsString()
  @IsNotEmpty()
  fileId: string;

  @IsArray()
  recommendations: any[];

  @IsString()
  @IsOptional()
  templateType?: string;

  @IsString()
  @IsOptional()
  domain?: string;

  @IsString()
  @IsOptional()
  outputLanguage?: string;
}

export class GetMoreDetailsDto {
  @IsArray()
  selectedItems: any[];

  @IsString()
  @IsNotEmpty()
  fileId: string;

  @IsString()
  @IsOptional()
  templateType?: string;

  @IsString()
  @IsOptional()
  domain?: string;

  @IsString()
  @IsOptional()
  outputLanguage?: string;
}

export class ChatRequestDto {
  @IsString()
  @IsNotEmpty()
  fileId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  message: string;

  @IsString()
  @IsOptional()
  domain?: string;
}

// --- Storage Controller DTOs ---

export class GetWorkItemDto {
  @IsString()
  @IsNotEmpty()
  fileId: string;

  @IsString()
  @IsOptional()
  lensAliasArn?: string;
}

export class StoreChatHistoryDto {
  @IsArray()
  @ArrayMaxSize(200)
  messages: any[];
}

// --- Report Controller DTOs ---

export class GenerateSMAReportDto {
  @IsArray()
  results: any[];

  @IsString()
  @IsOptional()
  fileName?: string;

  @IsString()
  @IsOptional()
  outputLanguage?: string;
}


export class UpdateWorkItemDto {
  @IsString()
  @IsOptional()
  uploadMode?: string;

  @IsArray()
  @IsOptional()
  usedLenses?: any[];

  @IsString()
  @IsOptional()
  lastModified?: string;

  @IsString()
  @IsOptional()
  fileType?: string;

  @IsString()
  @IsOptional()
  fileName?: string;

  // Sensitive fields explicitly excluded:
  // - analysisStatus (managed by the analysis engine only)
  // - workloadIds (managed by the analysis engine only)
}
