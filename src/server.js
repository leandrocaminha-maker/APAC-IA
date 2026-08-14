/**
 * src/server.js
 * Servidor Express principal — APAC-IA SALES.
 *
 * Centraliza:
 * - Webhook da Evolution API (receber mensagens WhatsApp)
 * - API REST para apps irmãos (enviar mensagens)
 * - Rotas admin (gerenciar prompts, conversas, métricas)
 * - Worker de fila de mensagens
 */
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import webhookRouter from './routes/webhook.js';
import apiRouter from './routes/api.js';
import adminRouter from './routes/admin.js';
import { startQueueProcessor } from './workers/queue-processor.js';

const app = express();

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS — permite chamadas dos apps irmãos
app.use(cors({
  origin: [
    'http://localhost:3000',       // AQUAP dev
    'http://localhost:3001',       // pagtos_ap dev
    'http://localhost:3002',       // NFS-e dev
    /\.supabase\.co$/,             // Supabase
    /\.w12app\.com\.br$/,          // EVO
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
}));

// Request logging
app.use((req, res, next) => {
  if (req.path !== '/health') {
    logger.debug(`${req.method} ${req.path}`);
  }
  next();
});

// ──────────────────────────────────────────────
// Rotas
// ──────────────────────────────────────────────

// Health check (sem auth)
app.get('/health', (req, res) => {
  res.json({
    service: 'apac-ia-sales',
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Webhook da Evolution API (sem auth — validado internamente)
app.use('/webhook', webhookRouter);

// API para apps irmãos (auth via X-Api-Key)
app.use('/api', apiRouter);

// Rotas admin (auth via X-Api-Key por enquanto)
app.use('/admin', adminRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// Error handler global
app.use((err, req, res, _next) => {
  logger.error('Erro não tratado:', err);
  res.status(500).json({
    error: 'Erro interno do servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ──────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────

app.listen(config.port, () => {
  logger.info(`🚀 APAC-IA SALES rodando na porta ${config.port}`);
  logger.info(`   Webhook: http://localhost:${config.port}/webhook/evolution`);
  logger.info(`   API:     http://localhost:${config.port}/api/`);
  logger.info(`   Admin:   http://localhost:${config.port}/admin/`);
  logger.info(`   Health:  http://localhost:${config.port}/health`);

  // Inicia worker de fila
  startQueueProcessor();
});

export default app;
