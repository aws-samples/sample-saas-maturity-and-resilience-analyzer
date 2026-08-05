import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:8080',
  },
  path: '/socket.io/', // Explicitly set the path
  pingInterval: 10000, // Send ping every 10 seconds
  pingTimeout: 5000,   // Wait 5 seconds for pong response
})
export class AnalyzerGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AnalyzerGateway.name);

  constructor(private readonly configService: ConfigService) {}

  handleConnection(client: Socket) {
    // Extract userId from query params (passed by frontend on connect)
    const userId = client.handshake?.query?.userId as string;
    if (userId) {
      client.join(`user:${userId}`);
      this.logger.log(`Client ${client.id} joined room user:${userId}`);
    } else {
      this.logger.warn(`Client ${client.id} connected without userId`);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  emitAnalysisProgress(data: {
    processedQuestions: number;
    totalQuestions: number;
    currentPillar: string;
    currentQuestion: string;
    currentCategory?: string;
  }, userId?: string) {
    if (userId) {
      this.server.to(`user:${userId}`).emit('analysisProgress', data);
    } else {
      // Fallback for non-authenticated mode
      this.server.emit('analysisProgress', data);
    }
  }

  emitImplementationProgress(data: {
    status: string;
    progress: number;
  }, userId?: string) {
    if (userId) {
      this.server.to(`user:${userId}`).emit('implementationProgress', data);
    } else {
      this.server.emit('implementationProgress', data);
    }
  }
}