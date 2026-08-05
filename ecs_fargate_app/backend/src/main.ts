import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { Request, Response, NextFunction } from 'express';
import { AuthGuard } from './shared/guards/auth.guard';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Disable request timeout for long-running operations
    bodyParser: false,
  });

  // Increase payload size limit and disable timeout
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  // Set a longer timeout for HTTP requests (25 minutes — SMA analysis with 16 questions can take ~17 min)
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.setTimeout(1500000); // 25 minutes
    res.setTimeout(1500000); // 25 minutes
    next();
  });

  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:8080',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-amzn-oidc-data'],
  });

  // Apply auth guard globally — all endpoints require authentication
  const configService = app.get(ConfigService);
  app.useGlobalGuards(new AuthGuard(configService));

  app.useGlobalPipes(new ValidationPipe());

  await app.listen(3000);
}
bootstrap();