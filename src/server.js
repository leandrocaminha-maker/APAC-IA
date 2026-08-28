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
import testeRouter from './routes/teste.js';
import crmRouter from './routes/crm.js';
import { startQueueProcessor } from './workers/queue-processor.js';
import { startEvoSyncWorker } from './workers/evo-sync-worker.js';
import { startFollowupWorker } from './workers/followup-worker.js';
import { startWhatsappMonitor } from './services/whatsapp-monitor.js';
import { startCampanhaWorker } from './workers/campanha-worker.js';

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
    'https://crm.apacademia.com.br',  // este serviço, atrás do nginx
    /\.apacademia\.com\.br$/,       // apps irmãos em produção
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

// Página de teste do agente (auth por senha única, sem usuário)
app.use('/teste', testeRouter);

// Painel do consultor (auth por consultor, cookie assinado)
app.use('/crm', crmRouter);

// A raiz do domínio é o painel — crm.apacademia.com.br leva direto a ele
// em vez de cair no 404 genérico.
app.get('/', (req, res) => res.redirect('/crm'));

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
  logger.info(`   Teste:   http://localhost:${config.port}/teste`);
  logger.info(`   Painel:  http://localhost:${config.port}/crm`);
  logger.info(`   Health:  http://localhost:${config.port}/health`);

  if (config.teste.habilitada && config.teste.senha === 'Leia') {
    logger.warn('[teste] Página de teste no ar com a senha padrão "Leia" — ' +
      'defina TESTE_SENHA no .env, ou TESTE_HABILITADO=false ao terminar os testes');
  }

  if (config.evo.dryRun) {
    logger.warn('[evo] EVO_DRY_RUN=true — nenhuma escrita chega ao EVO. ' +
      'Cadastro, agendamento e venda são simulados.');
  }

  if (config.crm.habilitado && !config.crm.evoWebhookSecret) {
    logger.warn('[crm] EVO_WEBHOOK_SECRET não definido — /webhook/evo responde 503 ' +
      'e o funil não recebe venda nem conversão do EVO.');
  }

  if (config.crm.habilitado && !config.crm.sessionSecret) {
    logger.warn('[crm] CRM_SESSION_SECRET não definido — as sessões do painel ' +
      'caem a cada restart do container.');
  }

  conferirTabelasDoCrm();

  // Inicia worker de fila
  startQueueProcessor();

  // Reconcilia o funil com o EVO — cobre o que o webhook do EVO não emite
  startEvoSyncWorker();

  // Vigia da sessão do WhatsApp. Primeiro na lista de propósito: se ela
  // subiu quebrada, é a primeira coisa que o log deve dizer — nada mais
  // aqui funciona sem ela.
  startWhatsappMonitor();

  // Follow-up de venda: o turno que o agente não tem sozinho
  startFollowupWorker();

  // Campanha ativa: nasce desligada, ver config.campanha
  startCampanhaWorker();
});

/**
 * Avisa no boot se a migration 002 ainda não rodou.
 *
 * Sem isto o sintoma é confuso: o login do painel responde "e-mail ou senha
 * incorretos" — porque a consulta a crm_users falha e o código trata como
 * usuário inexistente — e ninguém desconfia de tabela faltando. O mesmo
 * diagnóstico caro que a 001 já produziu uma vez.
 */
async function conferirTabelasDoCrm() {
  if (!config.crm.habilitado) return;

  const { supabase } = await import('./lib/supabase.js');
  const { error } = await supabase.from('crm_leads').select('id').limit(1);

  if (error?.code === 'PGRST205' || /schema cache/i.test(error?.message || '')) {
    logger.error(
      '[crm] As tabelas do CRM não existem (ou estão sem GRANT para service_role). ' +
      'Rode supabase/migrations/002_crm_schema.sql no SQL Editor do Supabase. ' +
      'Até lá o painel abre mas o login falha como se a senha estivesse errada.'
    );
  } else if (error) {
    logger.error('[crm] Não consegui ler crm_leads:', error.message);
  } else {
    logger.info('[crm] Tabelas do CRM acessíveis');
  }
}

export default app;
