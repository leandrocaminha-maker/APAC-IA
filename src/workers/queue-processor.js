/**
 * src/workers/queue-processor.js
 * Worker que processa a fila de mensagens (wa_message_queue).
 *
 * Roda como um setInterval dentro do servidor.
 * Processa mensagens pendentes e envia via Evolution API.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { sendText, sendMedia } from '../services/evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../services/contacts.js';

const POLL_INTERVAL_MS = 5_000;   // Poll a cada 5s
const BATCH_SIZE = 10;             // Máximo de mensagens por ciclo
const RATE_LIMIT_MS = 1_000;       // Delay entre envios (evita bloqueio)

let isProcessing = false;

/**
 * Processa um lote de mensagens pendentes.
 */
async function processBatch() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Busca mensagens pendentes que já passaram do horário agendado
    const { data: messages, error } = await supabase
      .from('wa_message_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      logger.error('[queue] Erro ao buscar fila:', error);
      return;
    }

    if (!messages || messages.length === 0) return;

    logger.info(`[queue] Processando ${messages.length} mensagem(ns)`);

    for (const msg of messages) {
      try {
        // Marca como processing
        await supabase
          .from('wa_message_queue')
          .update({ status: 'processing', attempts: msg.attempts + 1 })
          .eq('id', msg.id);

        // Envia via Evolution API
        let result;
        if (msg.content_type === 'text' || !msg.media_url) {
          result = await sendText(msg.phone, msg.content);
        } else {
          result = await sendMedia(msg.phone, msg.media_url, msg.content, msg.content_type);
        }

        // Registra no histórico
        const contact = await getOrCreateContact(msg.phone);
        const conversation = await getOrCreateConversation(contact.id);

        await saveMessage({
          conversationId: conversation.id,
          contactId: contact.id,
          direction: 'outbound',
          content: msg.content,
          contentType: msg.content_type || 'text',
          sentBy: `app:${msg.source_app}`,
          mediaUrl: msg.media_url,
          evolutionMsgId: result?.key?.id || null,
          status: 'sent',
        });

        // Marca como enviada
        await supabase
          .from('wa_message_queue')
          .update({
            status: 'sent',
            processed_at: new Date().toISOString(),
          })
          .eq('id', msg.id);

        logger.info(`[queue] ✓ Mensagem ${msg.id} enviada para ${msg.phone}`);

        // Rate limiting
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      } catch (err) {
        logger.error(`[queue] ✗ Erro na mensagem ${msg.id}:`, err.message);

        const newStatus = msg.attempts + 1 >= msg.max_attempts ? 'failed' : 'pending';
        await supabase
          .from('wa_message_queue')
          .update({
            status: newStatus,
            error: err.message,
          })
          .eq('id', msg.id);
      }
    }
  } finally {
    isProcessing = false;
  }
}

/** Inicia o worker de fila. */
export function startQueueProcessor() {
  logger.info(`[queue] Worker iniciado (poll a cada ${POLL_INTERVAL_MS / 1000}s)`);
  setInterval(processBatch, POLL_INTERVAL_MS);
  // Executa imediatamente na primeira vez
  processBatch();
}

/** Para testes — processa uma vez. */
export { processBatch };
