/**
 * src/workers/queue-processor.js
 * Worker que processa a fila de mensagens (wa_message_queue).
 *
 * Roda como um setInterval dentro do servidor.
 * Processa mensagens pendentes e envia via Evolution API.
 *
 * ## O que mudou em 31/08/2026, e por quê
 *
 * A Meta restringiu a conta por disparo automático. Este worker era o
 * ponto mais robótico do caminho de saída: lote de 10 a **exatamente** um
 * segundo de intervalo, poll de volta cinco segundos depois — ~40 por
 * minuto sustentado, com cadência de relógio. E sem nenhuma noção de
 * horário: um lote enfileirado às 2h saía às 2h.
 *
 * Três coisas entraram:
 *
 *   1. **Ritmo com folga.** Lote de 3, intervalo médio de
 *      `ENVIO_ESPACAMENTO_SEG` com ±40% de variação. Duas mensagens nunca
 *      saem com a mesma distância entre elas.
 *   2. **Janela de contato.** O que vence fora dela é REAGENDADO para a
 *      próxima abertura, com folga — não descartado, e não enviado de
 *      madrugada. Vale também para os apps irmãos: cobrança e NFS-e são
 *      mensagem de WhatsApp para a Meta, e o número é o mesmo.
 *   3. **Teto do número.** `limite-envio` conta o que a máquina já iniciou
 *      hoje somando campanha, apps irmãos e follow-up. Ao bater o teto a
 *      fila se cala por `FILA_PAUSA_TETO_MIN` minutos.
 */
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { esperar } from '../lib/ritmo.js';
import { sendText, sendMedia, numeroExiste } from '../services/evolution.js';
import { dentroDaJanela } from '../services/followup.js';
import { limiteEnvio } from '../services/limite-envio.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../services/contacts.js';

const POLL_INTERVAL_MS = 5_000;   // Poll a cada 5s

let isProcessing = false;

/**
 * Até quando a fila está calada por ter batido o teto diário.
 *
 * Sem isto ela refaria a contagem a cada poll de 5s até a meia-noite —
 * 17 mil consultas para descobrir sempre a mesma coisa.
 */
let pausadoAte = 0;

/**
 * A próxima saída possível para uma mensagem que venceu fora da janela.
 *
 * `dentroDaJanela` devolve o minuto EXATO da abertura (9h00:00), e é assim
 * que se constrói uma rajada: tudo que venceu durante a noite reaparece no
 * mesmo segundo. A folga de até 45 minutos desmancha o monte antes de ele
 * existir, e cabe dentro da janela mais curta que temos (sábado, 9h–13h).
 */
function proximaSaidaComFolga(agora = new Date()) {
  const alvo = dentroDaJanela(agora);
  if (alvo.getTime() === agora.getTime()) return alvo;   // já estava dentro
  return new Date(alvo.getTime() + Math.floor(Math.random() * 45 * 60_000));
}

/** A mensagem pode sair agora, ou tem de esperar a janela abrir? */
function foraDaJanela(agora = new Date()) {
  if (!config.fila.respeitaJanela) return false;
  return dentroDaJanela(agora).getTime() !== agora.getTime();
}

/**
 * Processa um lote de mensagens pendentes.
 */
async function processBatch() {
  if (isProcessing) return;
  if (Date.now() < pausadoAte) return;
  isProcessing = true;

  try {
    // O teto do número, conferido antes de buscar qualquer coisa: se não
    // cabe nenhuma, não vale nem ler a fila.
    const cota = await limiteEnvio.cota();
    if (!cota.ok) {
      pausadoAte = Date.now() + config.fila.pausaTetoMin * 60_000;
      logger.warn(
        `[queue] Fila pausada por ${config.fila.pausaTetoMin} min: ${cota.motivo}`
      );
      return;
    }

    // Busca mensagens pendentes que já passaram do horário agendado
    const { data: messages, error } = await supabase
      .from('wa_message_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(config.fila.lote);

    if (error) {
      logger.error('[queue] Erro ao buscar fila:', error);
      return;
    }

    if (!messages || messages.length === 0) return;

    // Fora da janela ninguém envia: o lote inteiro é empurrado para a
    // próxima abertura, espalhado. Não gasta tentativa — não é falha,
    // é hora errada.
    if (foraDaJanela()) {
      for (const msg of messages) {
        await supabase
          .from('wa_message_queue')
          .update({ scheduled_for: proximaSaidaComFolga().toISOString() })
          .eq('id', msg.id);
      }
      logger.info(
        `[queue] ${messages.length} mensagem(ns) fora da janela de contato — ` +
        'reagendadas para a próxima abertura'
      );
      return;
    }

    logger.info(`[queue] Processando ${messages.length} mensagem(ns) (cota do dia: ${cota.usados}/${cota.teto})`);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let saiuMensagem = false;

      try {
        // Número morto é sinal pesado no detector de spam, e a fila carrega
        // base fria de campanha. Falha aqui é definitiva: número que não
        // existe hoje não vai existir na terceira tentativa.
        if (config.envio.conferirExistencia && !(await numeroExiste(msg.phone))) {
          await supabase
            .from('wa_message_queue')
            .update({ status: 'failed', error: 'número não existe no WhatsApp' })
            .eq('id', msg.id);
          logger.warn(`[queue] ✗ ${msg.phone} não existe no WhatsApp — mensagem ${msg.id} descartada`);
          continue;
        }

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
        saiuMensagem = true;

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

        // A falha pode ter sido DEPOIS de a mensagem sair (gravação no
        // histórico, por exemplo). Espaça mesmo assim.
        saiuMensagem = true;
      }

      // Ritmo. Era `RATE_LIMIT_MS = 1_000` cravado — dez mensagens a
      // exatamente um segundo uma da outra, que não acontece por acaso e
      // é lido como tal.
      if (saiuMensagem && i < messages.length - 1) {
        await esperar(config.envio.espacamentoSeg);
      }
    }
  } finally {
    isProcessing = false;
  }
}

/** Inicia o worker de fila. */
export function startQueueProcessor() {
  logger.info(
    `[queue] Worker iniciado (poll a cada ${POLL_INTERVAL_MS / 1000}s, ` +
    `lote de ${config.fila.lote}, ~${config.envio.espacamentoSeg}s entre envios, ` +
    `janela ${config.fila.respeitaJanela ? 'respeitada' : 'IGNORADA'})`
  );
  setInterval(processBatch, POLL_INTERVAL_MS);
  // Executa imediatamente na primeira vez
  processBatch();
}

/** Para testes — processa uma vez. */
export { processBatch };
