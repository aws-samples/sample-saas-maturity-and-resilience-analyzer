import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalyzerModule } from './modules/analyzer/analyzer.module';
import { WellArchitectedModule } from './modules/well-architected/well-architected.module';
import { ReportModule } from './modules/report/report.module';
import { AuthModule } from './modules/auth/auth.module';
import { StorageModule } from './modules/storage/storage.module';
import { DomainModule } from './modules/domain/domain.module';
import { AuditLoggerMiddleware } from './shared/middleware/audit-logger.middleware';
import configuration from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    AnalyzerModule,
    WellArchitectedModule,
    ReportModule,
    AuthModule,
    StorageModule,
    DomainModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuditLoggerMiddleware).forRoutes('*');
  }
}