import { Module } from '@nestjs/common';
import { ReportService } from './report.service';
import { ReportController } from './report.controller';
import { AwsConfigService } from '../../config/aws.config';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [ReportService, AwsConfigService],
  controllers: [ReportController],
  exports: [ReportService],
})
export class ReportModule {}