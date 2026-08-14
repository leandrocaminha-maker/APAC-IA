/**
 * src/services/contacts.js
 * Gerenciamento de contatos e conversas no Supabase.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from './evolution.js';

/**
 * Busca ou cria um contato pelo número de telefone.
 * @param {string} phone - Número (qualquer formato)
 * @param {string} [name] - Nome do contato (opcional, para criação)
 * @returns {Promise<object>} O contato do banco
 */
export async function getOrCreateContact(phone, name = null) {
  const normalized = normalizePhone(phone);

  // Tenta buscar
  const { data: existing } = await supabase
    .from('wa_contacts')
    .select('*')
    .eq('phone', normalized)
    .single();

  if (existing) {
    // Atualiza nome se não tinha
    if (name && !existing.name) {
      await supabase
        .from('wa_contacts')
        .update({ name })
        .eq('id', existing.id);
      existing.name = name;
    }
    return existing;
  }

  // Cria novo
  const phoneLocal = normalized.startsWith('55') ? normalized.slice(2) : normalized;

  const { data: created, error } = await supabase
    .from('wa_contacts')
    .insert({
      phone: normalized,
      phone_local: phoneLocal,
      name: name || null,
      is_prospect: true,
    })
    .select()
    .single();

  if (error) {
    logger.error('[contacts] Erro ao criar contato:', error);
    throw error;
  }

  logger.info(`[contacts] Novo contato criado: ${normalized} (${name || 'sem nome'})`);
  return created;
}

/**
 * Busca ou cria uma conversa ativa para um contato.
 */
export async function getOrCreateConversation(contactId) {
  // Busca conversa ativa ou em modo humano
  const { data: existing } = await supabase
    .from('wa_conversations')
    .select('*')
    .eq('contact_id', contactId)
    .in('status', ['active', 'human'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existing) {
    // Atualiza timestamp da última mensagem
    await supabase
      .from('wa_conversations')
      .update({ last_message: new Date().toISOString() })
      .eq('id', existing.id);
    return existing;
  }

  // Cria nova conversa
  const { data: created, error } = await supabase
    .from('wa_conversations')
    .insert({
      contact_id: contactId,
      status: 'active',
      ai_enabled: true,
    })
    .select()
    .single();

  if (error) {
    logger.error('[contacts] Erro ao criar conversa:', error);
    throw error;
  }

  logger.info(`[contacts] Nova conversa criada para contact_id=${contactId}`);
  return created;
}

/**
 * Salva uma mensagem no histórico.
 */
export async function saveMessage({
  conversationId,
  contactId,
  direction,
  content,
  contentType = 'text',
  sentBy = 'bot',
  mediaUrl = null,
  evolutionMsgId = null,
  metadata = {},
  status = 'sent',
}) {
  const { data, error } = await supabase
    .from('wa_messages')
    .insert({
      conversation_id: conversationId,
      contact_id: contactId,
      direction,
      content,
      content_type: contentType,
      sent_by: sentBy,
      media_url: mediaUrl,
      evolution_msg_id: evolutionMsgId,
      metadata,
      status,
    })
    .select()
    .single();

  if (error) {
    logger.error('[contacts] Erro ao salvar mensagem:', error);
  }
  return data;
}

/**
 * Transfere conversa para atendimento humano.
 */
export async function handoffToHuman(conversationId, contactId, reason, assignedTo = null) {
  // Atualiza status da conversa
  await supabase
    .from('wa_conversations')
    .update({
      status: 'human',
      ai_enabled: false,
      assigned_to: assignedTo,
    })
    .eq('id', conversationId);

  // Registra handoff
  const { data, error } = await supabase
    .from('wa_human_handoffs')
    .insert({
      conversation_id: conversationId,
      contact_id: contactId,
      reason,
      assigned_to: assignedTo,
    })
    .select()
    .single();

  if (error) {
    logger.error('[contacts] Erro ao registrar handoff:', error);
  }

  logger.info(`[contacts] Handoff: conv=${conversationId}, motivo: ${reason}`);
  return data;
}

/**
 * Reativa o bot para uma conversa (após atendimento humano).
 */
export async function reactivateBot(conversationId) {
  await supabase
    .from('wa_conversations')
    .update({
      status: 'active',
      ai_enabled: true,
      assigned_to: null,
    })
    .eq('id', conversationId);

  logger.info(`[contacts] Bot reativado para conv=${conversationId}`);
}

export const contacts = {
  getOrCreateContact,
  getOrCreateConversation,
  saveMessage,
  handoffToHuman,
  reactivateBot,
};
