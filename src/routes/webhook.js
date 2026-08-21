/**
 * src/routes/webhook.js
 * Recebe webhooks da Evolution API (mensagens recebidas, status, etc.).
 */
import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage, handoffToHuman } from '../services/contacts.js';
import { aiAgent } from '../services/ai-agent.js';
import { sendText } from '../services/evolution.js';

const router = Router();

/**
 * POST /webhook/evolution
 * Endpoint chamado pela Evolution API quando eventos ocorrem.
 */
router.post('/evolution', async (req, res) => {
  try {
    const event = req.body;

    // Verifica webhook secret.
    // Se WEBHOOK_SECRET está configurado, a requisição é obrigada a
    // apresentá-lo — omitir o header não pode passar direto.
    if (config.webhookSecret) {
      const headerSecret = req.headers['x-webhook-secret'] || req.query.secret;
      if (headerSecret !== config.webhookSecret) {
        logger.warn('[webhook] Requisição rejeitada: secret ausente ou inválido');
        return res.status(401).json({ error: 'Webhook secret inválido' });
      }
    }

    // Determina o tipo de evento
    const eventType = event.event || event.type || '';

    logger.debug(`[webhook] Evento recebido: ${eventType}`);

    switch (eventType) {
      case 'messages.upsert':
      case 'MESSAGES_UPSERT':
        await handleIncomingMessage(event);
        break;

      case 'messages.update':
      case 'MESSAGES_UPDATE':
        await handleMessageStatus(event);
        break;

      case 'connection.update':
      case 'CONNECTION_UPDATE':
        handleConnectionUpdate(event);
        break;

      default:
        logger.debug(`[webhook] Evento ignorado: ${eventType}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('[webhook] Erro ao processar webhook:', err);
    // Retorna 200 mesmo com erro para não gerar retry infinito
    res.status(200).json({ received: true, error: err.message });
  }
});

/**
 * Processa mensagem recebida do WhatsApp.
 */
async function handleIncomingMessage(event) {
  const data = event.data || event;

  // Extrai dados da mensagem
  const messageData = data.message || data;
  const key = data.key || messageData.key || {};

  // Ignora mensagens de grupo (por enquanto)
  if (key.remoteJid?.includes('@g.us')) {
    logger.debug('[webhook] Ignorando mensagem de grupo');
    return;
  }

  // Extrai número do remetente
  const remoteJid = key.remoteJid || '';
  const phone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');

  if (!phone) {
    logger.warn('[webhook] Mensagem sem remetente identificável');
    return;
  }

  // Extrai conteúdo da mensagem
  const msg = messageData.message || messageData;
  let content = '';
  let contentType = 'text';
  let mediaUrl = null;

  if (msg.conversation) {
    content = msg.conversation;
  } else if (msg.extendedTextMessage?.text) {
    content = msg.extendedTextMessage.text;
  } else if (msg.imageMessage) {
    content = msg.imageMessage.caption || '[imagem]';
    contentType = 'image';
  } else if (msg.documentMessage) {
    content = msg.documentMessage.fileName || '[documento]';
    contentType = 'document';
  } else if (msg.audioMessage) {
    content = '[áudio]';
    contentType = 'audio';
  } else if (msg.videoMessage) {
    content = msg.videoMessage.caption || '[vídeo]';
    contentType = 'video';
  } else if (msg.buttonsResponseMessage) {
    content = msg.buttonsResponseMessage.selectedDisplayText || msg.buttonsResponseMessage.selectedButtonId || '';
  } else if (msg.listResponseMessage) {
    content = msg.listResponseMessage.title || msg.listResponseMessage.singleSelectReply?.selectedRowId || '';
  } else {
    // Tipo de mensagem não suportado
    content = '[mensagem não suportada]';
    contentType = 'unknown';
  }

  if (!content) {
    logger.debug('[webhook] Mensagem sem conteúdo extraível');
    return;
  }

  // Extrai nome do contato (push name do WhatsApp)
  const pushName = data.pushName || messageData.pushName || null;

  // Mensagem saindo do NOSSO número: ou é o eco do que a Leia acabou de mandar,
  // ou é o consultor humano digitando direto no WhatsApp. O segundo caso precisa
  // ser gravado; o primeiro já está no banco.
  if (key.fromMe) {
    await registrarMensagemDeSaida({ phone, content, contentType, evolutionMsgId: key.id });
    return;
  }

  logger.info(`[webhook] 📩 ${phone} (${pushName || '?'}): ${content.slice(0, 100)}`);

  // Busca ou cria contato e conversa
  const contact = await getOrCreateContact(phone, pushName);
  const conversation = await getOrCreateConversation(contact.id);

  // Salva mensagem recebida
  const savedMessage = await saveMessage({
    conversationId: conversation.id,
    contactId: contact.id,
    direction: 'inbound',
    content,
    contentType,
    sentBy: 'client',
    evolutionMsgId: key.id || null,
    metadata: { pushName, remoteJid },
    status: 'delivered',
  });

  // Se conversa está em modo humano, não processa com IA
  if (conversation.status === 'human') {
    logger.info(`[webhook] Conversa em modo humano — mensagem registrada sem resposta IA`);
    return;
  }

  // Se a mensagem é de tipo não-textual, responde genericamente
  if (contentType !== 'text' && contentType !== 'unknown') {
    if (contentType === 'audio') {
      await sendAndSave(
        phone,
        'Desculpe, ainda não consigo ouvir áudios 🙁 Poderia me enviar por texto?',
        conversation.id,
        contact.id
      );
      return;
    }
    // Imagens, documentos, vídeos → registra mas não processa com IA
    return;
  }

  // Processa com agente IA
  try {
    const aiResponse = await aiAgent.processMessage({
      message: content,
      conversationId: conversation.id,
      excludeMessageId: savedMessage?.id,
      contactInfo: {
        name: contact.name,
        phone: contact.phone,
        is_prospect: contact.is_prospect,
        tags: contact.tags,
      },
    });

    // Se IA solicitou handoff
    if (aiResponse.action === 'handoff') {
      await handoffToHuman(
        conversation.id,
        contact.id,
        aiResponse.handoffReason
      );
    }

    // Envia resposta
    if (aiResponse.text) {
      await sendAndSave(
        phone,
        aiResponse.text,
        conversation.id,
        contact.id
      );
    }
  } catch (err) {
    logger.error(`[webhook] Erro no processamento IA para ${phone}:`, err);

    // Resposta de fallback
    await sendAndSave(
      phone,
      'Olá! Estou com um probleminha técnico, mas já vou te atender. Um momento! 😊',
      conversation.id,
      contact.id
    );
  }
}

/**
 * Registra uma mensagem que saiu do NOSSO número.
 *
 * A Evolution devolve pelo webhook tudo o que sai da instância, inclusive o que
 * a própria Leia acabou de enviar. O caso que interessa aqui é o outro: o
 * **consultor humano respondendo direto do WhatsApp**, no aparelho. Até
 * 20/08/2026 essas mensagens eram descartadas, e o histórico ficava com o
 * cliente falando e ninguém respondendo — o que falseava a análise das conversas
 * e impediria o agente de retomar uma conversa que passou por um humano sem
 * repetir o que já foi combinado.
 *
 * Não roda a IA: mensagem nossa não pede resposta nossa.
 *
 * **Como distinguir do eco.** Duas checagens, porque uma só não basta:
 *
 * 1. `evolution_msg_id` — o envio da Leia grava esse id na hora. Se já existe,
 *    este webhook é o eco do nosso próprio disparo.
 * 2. Mesmo conteúdo, mesmo contato, nos últimos 30 segundos. Cobre dois casos
 *    que a primeira não pega: a corrida entre o webhook chegar e o `sendAndSave`
 *    terminar de gravar, e o envio em que a Evolution não devolveu `key.id`
 *    (aí a mensagem da Leia foi gravada com `evolution_msg_id` nulo).
 */
async function registrarMensagemDeSaida({ phone, content, contentType, evolutionMsgId }) {
  const contact = await getOrCreateContact(phone);
  const conversation = await getOrCreateConversation(contact.id);

  if (evolutionMsgId) {
    const { data: mesmoId } = await supabase
      .from('wa_messages')
      .select('id')
      .eq('evolution_msg_id', evolutionMsgId)
      .limit(1);

    if (mesmoId?.length) {
      logger.debug('[webhook] Eco do nosso próprio envio (id já registrado)');
      return;
    }
  }

  const desde = new Date(Date.now() - 30_000).toISOString();
  const { data: mesmoTexto } = await supabase
    .from('wa_messages')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('direction', 'outbound')
    .eq('content', content)
    .gte('created_at', desde)
    .limit(1);

  if (mesmoTexto?.length) {
    logger.debug('[webhook] Eco do nosso próprio envio (mesmo texto agora há pouco)');
    return;
  }

  await saveMessage({
    conversationId: conversation.id,
    contactId: contact.id,
    direction: 'outbound',
    content,
    contentType,
    sentBy: 'human:whatsapp',
    evolutionMsgId: evolutionMsgId || null,
    status: 'sent',
  });

  logger.info(`[webhook] 👤 consultor → ${phone}: ${content.slice(0, 80)}`);
}

/**
 * Envia texto e salva no histórico.
 */
async function sendAndSave(phone, text, conversationId, contactId) {
  const result = await sendText(phone, text);

  await saveMessage({
    conversationId,
    contactId,
    direction: 'outbound',
    content: text,
    contentType: 'text',
    sentBy: 'bot',
    evolutionMsgId: result?.key?.id || null,
    status: 'sent',
  });
}

/**
 * Processa atualização de status de mensagem (delivered, read).
 */
async function handleMessageStatus(event) {
  const data = event.data || event;
  const key = data.key || {};
  const status = data.status || data.update?.status;
  const evolutionMsgId = key.id;

  if (!evolutionMsgId || !status) return;

  // Mapeia status da Evolution para nosso enum
  const statusMap = {
    SERVER_ACK: 'sent',
    DELIVERY_ACK: 'delivered',
    READ: 'read',
    PLAYED: 'read',
  };

  const ourStatus = statusMap[status];
  if (!ourStatus) return;

  await supabase
    .from('wa_messages')
    .update({ status: ourStatus })
    .eq('evolution_msg_id', evolutionMsgId);
}

/**
 * Processa atualização de status da conexão.
 */
function handleConnectionUpdate(event) {
  const data = event.data || event;
  const state = data.state || data.status;
  logger.info(`[webhook] 📡 Status da conexão: ${state}`);
}

export default router;
