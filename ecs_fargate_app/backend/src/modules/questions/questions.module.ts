import { Module } from '@nestjs/common';
import { QuestionsService } from './questions.service';
import { AwsConfigService } from '../../config/aws.config';
import { ConfigService } from '@nestjs/config';

@Module({
  providers: [QuestionsService, AwsConfigService, ConfigService],
  exports: [QuestionsService],
})
export class QuestionsModule {}