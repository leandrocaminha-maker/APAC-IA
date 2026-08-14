/**
 * src/routes/api.js
 * API REST para os apps irmãos (AQUAP, pagtos_ap, NFS-e).
 *
 * Cada app autentica com uma API key no header X-Api-Key.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { sendText, sendMedia, getConnectionStatus, normalizePhone } from '../services/evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../services/contacts.js';

const router = Router();

// ──────────────────────────────────────────────
// Middleware: autenticação por API key
// ──────────────────────────────────────────────

function authenticateApp(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Header X-Api-Key obrigatório' });
  }

  // Identifica qual app está chamando
  const apps = config.appKeys;
  let appName = null;

  if (apiKey === apps.aquap) appName = 'aquap';
  else if (apiKey === apps.pagtos) appName = 'pagtos_ap';
  else if (apiKey === apps.nfse) appName = 'nfse';

  if (!appName) {
    return res.status(403).json({ error: 'API key inválida' });
  }

  req.appName = appName;
  next();
}

router.use(authenticateApp);

// ──────────────────────────────────────────────
// POST /api/send — Enviar mensagem individual
// ──────────────────────────────────────────────

router.post('/send', async (req, res) => {
  try {
    const { phone, message, content_type, media_url, caption } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'phone e message são obrigatórios' });
    }

    const normalized = normalizePhone(phone);
    logger.info(`[api] ${req.appName} → enviar para ${normalized}`);

    // Envia via Evolution
    let result;
    if (content_type === 'image' || content_type === 'document') {
      result = await sendMedia(normalized, media_url, caption || message, content_type);
    } else {
      result = await sendText(normalized, message);
    }

    // Registra no histórico
    const contact = await getOrCreateContact(normalized);
    const conversation = await getOrCreateConversation(contact.id);

    await saveMessage({
      conversationId: conversation.id,
      contactId: contact.id,
      direction: 'outbound',
      content: message,
      contentType: content_type || 'text',
      sentBy: `app:${req.appName}`,
      mediaUrl: media_url,
      evolutionMsgId: result?.key?.id || null,
      status: 'sent',
    });

    res.json({
      success: true,
      message_id: result?.key?.id || null,
      phone: normalized,
    });
  } catch (err) {
    logger.error(`[api] Erro no envio (${req.appName}):`, err);
    res.status(500).json({ error: 'Falha ao enviar mensagem', detail: err.message });
  }
});

// ──────────────────────────────────────────────
// POST /api/send-bulk — Envio em lote
// ──────────────────────────────────────────────

router.post('/send-bulk', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages deve ser um array não-vazio' });
    }

    if (messages.length > 100) {
      return res.status(400).json({ error: 'Máximo de 100 mensagens por lote' });
    }

    logger.info(`[api] ${req.appName} → envio em lote: ${messages.length} mensagens`);

    // Enfileira todas as mensagens
    const queueItems = messages.map(msg => ({
      phone: normalizePhone(msg.phone),
      content: msg.message,
      content_type: msg.content_type || 'text',
      media_url: msg.media_url || null,
      source_app: req.appName,
      status: 'pending',
      scheduled_for: msg.scheduled_for || new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from('wa_message_queue')
      .insert(queueItems)
      .select('id, phone, status');

    if (error) throw error;

    res.json({
      success: true,
      queued: data.length,
      items: data,
    });
  } catch (err) {
    logger.error(`[api] Erro no envio em lote (${req.appName}):`, err);
    res.status(500).json({ error: 'Falha ao enfileirar mensagens', detail: err.message });
  }
});

// ──────────────────────────────────────────────
// GET /api/conversations/:phone — Histórico
// ──────────────────────────────────────────────

router.get('/conversations/:phone', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

    // Busca contato
    const { data: contact } = await supabase
      .from('wa_contacts')
      .select('id, name, phone, is_prospect, tags')
      .eq('phone', phone)
      .single();

    if (!contact) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }

    // Busca mensagens
    const { data: messages } = await supabase
      .from('wa_messages')
      .select('id, direction, content, content_type, sent_by, status, created_at')
      .eq('contact_id', contact.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    res.json({
      contact,
      messages: (messages || []).reverse(),
    });
  } catch (err) {
    logger.error(`[api] Erro ao buscar conversa:`, err);
    res.status(500).json({ error: 'Falha ao buscar conversa' });
  }
});

// ──────────────────────────────────────────────
// POST /api/handoff — Transferir para humano
// ──────────────────────────────────────────────

router.post('/handoff', async (req, res) => {
  try {
    const { phone, reason, assigned_to } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'phone é obrigatório' });
    }

    const normalized = normalizePhone(phone);

    const { data: contact } = await supabase
      .from('wa_contacts')
      .select('id')
      .eq('phone', normalized)
      .single();

    if (!contact) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }

    const { data: conversation } = await supabase
      .from('wa_conversations')
      .select('id')
      .eq('contact_id', contact.id)
      .in('status', ['active', 'human'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!conversation) {
      return res.status(404).json({ error: 'Nenhuma conversa ativa' });
    }

    const { handoffToHuman } = await import('../services/contacts.js');
    await handoffToHuman(conversation.id, contact.id, reason || 'Solicitação via API', assigned_to);

    res.json({ success: true, conversation_id: conversation.id });
  } catch (err) {
    logger.error(`[api] Erro no handoff:`, err);
    res.status(500).json({ error: 'Falha ao transferir conversa' });
  }
});

// ──────────────────────────────────────────────
// GET /api/status — Health check + status WhatsApp
// ──────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const connectionStatus = await getConnectionStatus();
    res.json({
      service: 'apac-ia-sales',
      status: 'running',
      whatsapp: connectionStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.json({
      service: 'apac-ia-sales',
      status: 'running',
      whatsapp: { error: err.message },
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
