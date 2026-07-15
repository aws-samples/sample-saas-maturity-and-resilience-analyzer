import { Module } from '@nestjs/common';
import { AnalyzerController } from './analyzer.controller';
import { AnalyzerService } from './analyzer.service';
import { AnalyzerGateway } from './analyzer.gateway';
import { AwsConfigService } from '../../config/aws.config';
import { StorageModule } from '../storage/storage.module';
import { QuestionsModule } from '../questions/questions.module';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [StorageModule, QuestionsModule],
  controllers: [AnalyzerController],
  providers: [AnalyzerService, AnalyzerGateway, AwsConfigService, ConfigService],
  exports: [AnalyzerService]
})
export class AnalyzerModule { }