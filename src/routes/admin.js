/**
 * src/routes/admin.js
 * Rotas administrativas para gerenciar prompts, conversas e métricas.
 *
 * Protegido por ADMIN_API_KEY (header X-Api-Key).
 * Em produção, considerar autenticação mais robusta (JWT/Supabase Auth).
 */
import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { aiAgent } from '../services/ai-agent.js';
import { getConnectionStatus, getQrCode } from '../services/evolution.js';
import { reactivateBot } from '../services/contacts.js';

const router = Router();

// Canal das conversas da página /teste. Elas ficam nas mesmas tabelas do
// WhatsApp para a análise ser uma só, mas fora das métricas de atendimento.
const CANAL_TESTE = 'web-test';

// ──────────────────────────────────────────────
// Middleware: autenticação de admin
//
// Estas rotas expõem histórico de conversas, telefones de clientes
// e o QR code de pareamento do WhatsApp — quem obtém o QR consegue
// parear o número da academia. Por isso o comportamento é
// "fail-closed": sem ADMIN_API_KEY configurada, tudo é bloqueado.
// ──────────────────────────────────────────────

function authenticateAdmin(req, res, next) {
  if (!config.adminApiKey) {
    logger.error('[admin] ADMIN_API_KEY não configurada — rotas /admin bloqueadas');
    return res.status(503).json({ error: 'Admin não configurado (defina ADMIN_API_KEY)' });
  }

  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Header X-Api-Key obrigatório' });
  }

  if (apiKey !== config.adminApiKey) {
    logger.warn(`[admin] Tentativa de acesso com chave inválida (${req.method} ${req.path})`);
    return res.status(403).json({ error: 'API key inválida' });
  }

  next();
}

router.use(authenticateAdmin);

// ──────────────────────────────────────────────
// Prompts
// ──────────────────────────────────────────────

/** GET /admin/prompts — Lista todos os prompts */
router.get('/prompts', async (req, res) => {
  const { data, error } = await supabase
    .from('wa_ai_prompts')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** GET /admin/prompts/:slug — Busca prompt por slug */
router.get('/prompts/:slug', async (req, res) => {
  const { data, error } = await supabase
    .from('wa_ai_prompts')
    .select('*')
    .eq('slug', req.params.slug)
    .single();

  if (error) return res.status(404).json({ error: 'Prompt não encontrado' });
  res.json(data);
});

/** PUT /admin/prompts/:id — Atualiza prompt */
router.put('/prompts/:id', async (req, res) => {
  const { title, system_prompt, is_active } = req.body;

  const update = {};
  if (title !== undefined) update.title = title;
  if (system_prompt !== undefined) update.system_prompt = system_prompt;
  if (is_active !== undefined) update.is_active = is_active;

  const { data, error } = await supabase
    .from('wa_ai_prompts')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Invalida cache do prompt no agente
  aiAgent.invalidatePromptCache();
  logger.info(`[admin] Prompt ${req.params.id} atualizado`);

  res.json(data);
});

/** POST /admin/prompts — Cria novo prompt */
router.post('/prompts', async (req, res) => {
  const { slug, title, system_prompt } = req.body;

  if (!slug || !title || !system_prompt) {
    return res.status(400).json({ error: 'slug, title e system_prompt são obrigatórios' });
  }

  const { data, error } = await supabase
    .from('wa_ai_prompts')
    .insert({ slug, title, system_prompt })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ──────────────────────────────────────────────
// Conversas
// ──────────────────────────────────────────────

/** GET /admin/conversations — Lista conversas ativas */
router.get('/conversations', async (req, res) => {
  const status = req.query.status || 'active';
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

  const { data, error } = await supabase
    .from('wa_conversations')
    .select(`
      id, status, ai_enabled, assigned_to, last_message, started_at,
      wa_contacts ( id, phone, name, is_prospect, tags )
    `)
    .eq('status', status)
    .order('last_message', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** POST /admin/conversations/:id/reactivate — Reativa bot */
router.post('/conversations/:id/reactivate', async (req, res) => {
  try {
    await reactivateBot(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Handoffs pendentes
// ──────────────────────────────────────────────

/** GET /admin/handoffs — Lista handoffs pendentes */
router.get('/handoffs', async (req, res) => {
  const { data, error } = await supabase
    .from('wa_human_handoffs')
    .select(`
      id, reason, assigned_to, resolved, created_at,
      wa_contacts ( id, phone, name ),
      wa_conversations ( id, status )
    `)
    .eq('resolved', false)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** POST /admin/handoffs/:id/resolve — Marca handoff como resolvido */
router.post('/handoffs/:id/resolve', async (req, res) => {
  const { data, error } = await supabase
    .from('wa_human_handoffs')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ──────────────────────────────────────────────
// Métricas
// ──────────────────────────────────────────────

/** GET /admin/metrics — Métricas de atendimento */
router.get('/metrics', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Total de conversas ativas — sem o canal da página de teste, senão a
    // rodada de testes internos aparece como demanda de cliente.
    const { count: activeConvs } = await supabase
      .from('wa_conversations')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active')
      .neq('channel', CANAL_TESTE);

    // Conversas em modo humano
    const { count: humanConvs } = await supabase
      .from('wa_conversations')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'human')
      .neq('channel', CANAL_TESTE);

    // Conversas da página de teste, contadas à parte
    const { count: testConvs } = await supabase
      .from('wa_conversations')
      .select('*', { count: 'exact', head: true })
      .eq('channel', CANAL_TESTE);

    // Mensagens hoje
    const { count: msgsToday } = await supabase
      .from('wa_messages')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', `${today}T00:00:00`);

    // Total de contatos
    const { count: totalContacts } = await supabase
      .from('wa_contacts')
      .select('*', { count: 'exact', head: true });

    // Handoffs pendentes
    const { count: pendingHandoffs } = await supabase
      .from('wa_human_handoffs')
      .select('*', { count: 'exact', head: true })
      .eq('resolved', false);

    // Fila pendente
    const { count: queuePending } = await supabase
      .from('wa_message_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    res.json({
      timestamp: new Date().toISOString(),
      conversations: {
        active: activeConvs || 0,
        human: humanConvs || 0,
      },
      messages: {
        today: msgsToday || 0,
      },
      contacts: {
        total: totalContacts || 0,
      },
      handoffs: {
        pending: pendingHandoffs || 0,
      },
      queue: {
        pending: queuePending || 0,
      },
      testes: {
        conversations: testConvs || 0,
      },
    });
  } catch (err) {
    logger.error('[admin] Erro nas métricas:', err);
    res.status(500).json({ error: 'Falha ao buscar métricas' });
  }
});

// ──────────────────────────────────────────────
// WhatsApp Connection
// ──────────────────────────────────────────────

/** GET /admin/whatsapp/status — Status da conexão */
router.get('/whatsapp/status', async (req, res) => {
  try {
    const status = await getConnectionStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/whatsapp/qrcode — QR Code para conectar */
router.get('/whatsapp/qrcode', async (req, res) => {
  try {
    const qr = await getQrCode();
    res.json(qr);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Knowledge Files
// ──────────────────────────────────────────────

/** GET /admin/knowledge — Lista os knowledge files disponíveis */
router.get('/knowledge', async (req, res) => {
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const { join, extname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const knowledgeDir = join(__dirname, '..', 'prompts', 'knowledge');

    const files = await readdir(knowledgeDir);
    const mdFiles = files.filter(f => extname(f) === '.md');

    const details = await Promise.all(
      mdFiles.map(async (f) => {
        const s = await stat(join(knowledgeDir, f));
        return {
          file: f,
          size: s.size,
          modified: s.mtime.toISOString(),
        };
      })
    );

    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// Conversas da página de teste
// ──────────────────────────────────────────────

/**
 * GET /admin/conversas-teste — Transcrições da página /teste.
 *
 * Atalho para ler o que os testadores conversaram sem abrir o Supabase.
 * Para análise em arquivo (transcrições + números), use `npm run conversas`.
 */
router.get('/conversas-teste', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

  const { data: conversas, error } = await supabase
    .from('wa_conversations')
    .select('id, status, started_at, last_message, wa_contacts ( name, phone )')
    .eq('channel', CANAL_TESTE)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  if (!conversas.length) return res.json([]);

  const { data: mensagens } = await supabase
    .from('wa_messages')
    .select('conversation_id, direction, content, metadata, created_at')
    .in('conversation_id', conversas.map(c => c.id))
    .order('created_at', { ascending: true });

  res.json(conversas.map(c => ({
    ...c,
    mensagens: (mensagens || [])
      .filter(m => m.conversation_id === c.id)
      .map(m => ({
        de: m.direction === 'inbound' ? 'testador' : 'leia',
        texto: m.content,
        handoff: m.metadata?.handoff || false,
        em: m.created_at,
      })),
  })));
});

/** POST /admin/reload-cache — Força recarga de prompt + knowledge files */
router.post('/reload-cache', (req, res) => {
  aiAgent.invalidatePromptCache();
  logger.info('[admin] Cache de prompt e knowledge invalidado manualmente');
  res.json({ success: true, message: 'Cache invalidado. Próxima mensagem usará dados atualizados.' });
});

export default router;
