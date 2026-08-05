import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { RiskSummaryDto, UpdateAnswerDto, AssociateLensDto, CreateWorkloadDto } from '../../shared/dto/request-validation.dto';
import { WellArchitectedService } from './well-architected.service';
import { CreateMilestoneDto } from '../../shared/dto/analysis.dto';

@Controller('well-architected')
export class WellArchitectedController {
  private readonly logger = new Logger(WellArchitectedController.name);

  constructor(private readonly waService: WellArchitectedService) { }

  @Get('lens-metadata')
  async getLensMetadata() {
    try {
      return await this.waService.getLensMetadata();
    } catch (error) {
      this.logger.error('Failed to get lens metadata:', error);
      throw new HttpException(
        `Failed to retrieve lens metadata. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('review/:workloadId')
  async getLensReview(@Param('workloadId') workloadId: string) {
    try {
      return await this.waService.getLensReview(workloadId);
    } catch (error) {
      this.logger.error(`Failed to get lens review for workload ${workloadId}:`, error);
      throw new HttpException(
        `Failed to retrieve workload review. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('risk-summary')
  async getRiskSummary(@Body() body: RiskSummaryDto) {
    try {
      const { workloadId, lensAliasArn } = body;
      return await this.waService.getRiskSummary(workloadId, lensAliasArn);
    } catch (error) {
      this.logger.error(`Failed to get risk summary for workload ${body.workloadId}:`, error);
      throw new HttpException(
        `Failed to retrieve risk summary. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('milestone')
  async createMilestone(@Body() createMilestoneDto: CreateMilestoneDto) {
    try {
      return await this.waService.createMilestone(
        createMilestoneDto.workloadId,
        createMilestoneDto.milestoneName
      );
    } catch (error) {
      this.logger.error('Failed to create milestone:', error);
      throw new HttpException(
        `Failed to create milestone. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('answer/:workloadId')
  async updateAnswer(
    @Param('workloadId') workloadId: string,
    @Body() body: UpdateAnswerDto
  ) {
    try {
      return await this.waService.updateAnswer(
        workloadId,
        body.questionId,
        body.selectedChoices,
        body.notApplicableChoices || [],
        body.notSelectedChoices,
        body.lensAliasArn
      );
    } catch (error) {
      this.logger.error(`Failed to update answer for workload ${workloadId}, for question ${body.questionId}:`, error);
      throw new HttpException(
        `Failed to update answer. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('associate-lens/:workloadId')
  async associateLens(
    @Param('workloadId') workloadId: string,
    @Body() body: AssociateLensDto
  ) {
    try {
      await this.waService.associateLens(workloadId, body.lensAliasArn);
      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to associate lens with workload ${workloadId}:`, error);
      throw new HttpException(
        `Failed to associate lens with workload. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('workload/create')
  async createWorkload(@Body() body: CreateWorkloadDto) {
    try {
      return await this.waService.createWorkload(body.isTemp, body.lensAliasArn);
    } catch (error) {
      this.logger.error('Failed to create workload:', error);
      throw new HttpException(
        `Failed to create workload. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Delete('workload/:workloadId')
  async deleteWorkload(@Param('workloadId') workloadId: string) {
    try {
      await this.waService.deleteWorkload(workloadId);
    } catch (error) {
      this.logger.error(`Failed to delete workload ${workloadId}:`, error);
      throw new HttpException(
        `Failed to delete workload. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get('workloads')
  async listWorkloads() {
    try {
      return await this.waService.listWorkloads();
    } catch (error) {
      this.logger.error('Failed to list workloads:', error);
      throw new HttpException(
        `Failed to list workloads. Please try again.`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}