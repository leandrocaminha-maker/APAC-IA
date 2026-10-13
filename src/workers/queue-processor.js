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
 *
 * ## Duas pistas desde 12/10/2026
 *
 * A fila é uma tabela só e tem duas saídas: a do número principal, descrita
 * acima, e a do número alternativo (linhas `alt:…`), no fim do arquivo.
 */
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { esperar, folgaMs } from '../lib/ritmo.js';
import { sendText, sendMedia, numeroExiste } from '../services/evolution.js';
import { dentroDaJanela } from '../services/followup.js';
import { limiteEnvio } from '../services/limite-envio.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../services/contacts.js';
import { numeroAlternativo } from '../services/numero-alternativo.js';
import { PREFIXO_ALT, PREFIXO_LINK, TETO_MAXIMO, ehOrigemDeLink } from '../services/pesquisa-regras.js';

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

    // Busca mensagens pendentes que já passaram do horário agendado.
    //
    // Menos as do número alternativo (`alt:…`), que têm pista própria lá
    // embaixo. O filtro vale SEMPRE, com ou sem número alternativo
    // configurado: tirar a variável do `.env` com pesquisa na fila não pode
    // fazer a pesquisa sair pelo número de atendimento.
    const { data: messages, error } = await supabase
      .from('wa_message_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .not('source_app', 'like', `${PREFIXO_ALT}%`)
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

// ──────────────────────────────────────────────
// A pista do número alternativo
//
// As linhas `alt:…` da fila saem por outra instância da Evolution, com teto
// e ritmo próprios (`config.envioAlt`). É outra pista, e não um desvio
// dentro da de cima, por dois motivos:
//
//   - **Uma não segura a outra.** A pista principal dorme ~75s entre dois
//     envios, com a trava ligada; centenas de mensagens de pesquisa na mesma
//     pista atrasariam a cobrança e a nota fiscal dos apps irmãos. E o teto
//     de um número batido não pode calar o outro.
//
//   - **O número novo pede uma regra a mais.** Aqui sai UMA mensagem por
//     vez, e duas ABERTURAS nunca saem com menos de 60% do piso do
//     agendamento entre elas — aconteça o que acontecer. É o que impede o
//     acumulado de uma queda de sessão, ou de uma noite, de virar rajada na
//     volta: o que venceu escoa no ritmo de sempre, e o que não couber no
//     teto do dia espera o seguinte. (Na pista principal isso já foi
//     incidente: 22 mensagens em 22s na reconexão de 28/08/2026.)
//
// O link e as respostas não abrem conversa: não contam no teto e só
// respeitam o espaçamento curto.
// ──────────────────────────────────────────────

const POLL_ALT_MS = 15_000;

const alt = {
  ocupada: false,
  pausadaAte: 0,        // sessão fora do ar
  semCotaAte: 0,        // teto do dia batido: aberturas param, links seguem
  proximoEnvio: 0,      // espaçamento entre dois envios quaisquer
  proximaAbertura: 0,   // piso entre duas aberturas
};

/** A próxima linha vencida da pista — qualquer uma, ou só link. */
async function proximaDoAlternativo({ soLinks = false } = {}) {
  const { data, error } = await supabase
    .from('wa_message_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .like('source_app', `${soLinks ? PREFIXO_LINK : PREFIXO_ALT}%`)
    .order('scheduled_for', { ascending: true })
    .limit(1);

  if (error) {
    logger.error('[queue/alt] Erro ao buscar fila:', error.message);
    return null;
  }
  return data?.[0] ?? null;
}

async function enviarPeloAlternativo(msg) {
  const link = ehOrigemDeLink(msg.source_app);

  try {
    await supabase
      .from('wa_message_queue')
      .update({ status: 'processing', attempts: msg.attempts + 1 })
      .eq('id', msg.id);

    await numeroAlternativo.enviar(msg.phone, msg.content, {
      tipo: link ? 'link' : 'abertura',
      origem: msg.source_app,
    });

    const agora = new Date().toISOString();
    await supabase
      .from('wa_message_queue')
      .update({ status: 'sent', processed_at: agora })
      .eq('id', msg.id);

    if (!link) {
      // O alvo vira `enviado` AGORA, sem esperar a reconciliação do worker
      // de campanha, que roda de dez em dez minutos. Quem responde "sim"
      // responde em um — e com o alvo ainda `agendado` a resposta não
      // acharia a pesquisa, e a pessoa ficaria sem o link que pediu.
      await supabase
        .from('crm_campanha_alvos')
        .update({ status: 'enviado', sent_at: agora })
        .eq('queue_id', msg.id)
        .eq('status', 'agendado');

      alt.proximaAbertura = Date.now() + folgaMs(config.envioAlt.intervaloMinimoMin * 60 * 0.6, 0.2);
    }

    logger.info(`[queue/alt] ✓ ${link ? 'Link' : 'Abertura'} ${msg.id} enviada para ${msg.phone}`);
  } catch (err) {
    logger.error(`[queue/alt] ✗ Erro na mensagem ${msg.id}:`, err.message);

    await supabase
      .from('wa_message_queue')
      .update({
        status: msg.attempts + 1 >= msg.max_attempts ? 'failed' : 'pending',
        error: err.message,
      })
      .eq('id', msg.id);
  }

  // Com sucesso ou com falha: a próxima não sai em 15 segundos.
  alt.proximoEnvio = Date.now() + folgaMs(config.envioAlt.espacamentoSeg);
}

/** Um passo da pista: no máximo uma mensagem. */
async function processarAlternativo() {
  const agora = Date.now();
  if (alt.ocupada || agora < alt.pausadaAte || agora < alt.proximoEnvio) return;
  alt.ocupada = true;

  try {
    let msg = await proximaDoAlternativo();
    if (!msg) return;

    // Fora da janela: tudo o que venceu vai para a próxima abertura, com
    // folga — como na pista principal.
    if (foraDaJanela()) {
      const { data: vencidas } = await supabase
        .from('wa_message_queue')
        .select('id')
        .eq('status', 'pending')
        .lte('scheduled_for', new Date().toISOString())
        .like('source_app', `${PREFIXO_ALT}%`)
        .limit(500);

      for (const vencida of vencidas ?? []) {
        await supabase
          .from('wa_message_queue')
          .update({ scheduled_for: proximaSaidaComFolga().toISOString() })
          .eq('id', vencida.id);
      }
      logger.info(`[queue/alt] ${vencidas?.length ?? 0} mensagem(ns) fora da janela de contato — reagendadas`);
      return;
    }

    // Abertura só sai com o piso cumprido e com cota. Sem um dos dois, a
    // vez é de um link, se houver — conversa já aberta não espera teto.
    if (!ehOrigemDeLink(msg.source_app)) {
      let podeAbrir = agora >= alt.proximaAbertura && agora >= alt.semCotaAte;

      if (podeAbrir) {
        const cota = await limiteEnvio.cotaAlternativo();
        if (!cota.ok) {
          alt.semCotaAte = agora + config.fila.pausaTetoMin * 60_000;
          logger.warn(`[queue/alt] Aberturas paradas por ${config.fila.pausaTetoMin} min: ${cota.motivo}`);
          podeAbrir = false;
        }
      }

      if (!podeAbrir) {
        msg = await proximaDoAlternativo({ soLinks: true });
        if (!msg) return;
      }
    }

    // Sessão fora do ar não gasta tentativa: a linha fica como está.
    if (!(await numeroAlternativo.conectado())) {
      alt.pausadaAte = Date.now() + 5 * 60_000;
      logger.warn(
        `[queue/alt] Número alternativo fora do ar (sessão "${await numeroAlternativo.estadoDaConexao()}") — ` +
        'pista parada por 5 min. Parear em Ajustes → WhatsApp — número alternativo.'
      );
      return;
    }

    await enviarPeloAlternativo(msg);
  } finally {
    alt.ocupada = false;
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

  if (!numeroAlternativo.configurado()) {
    logger.info('[queue/alt] Sem número alternativo (EVOLUTION_INSTANCE_ALT vazio) — pista desligada');
    return;
  }

  const { tetoDiario, rampa, intervaloMinimoMin, espacamentoSeg } = config.envioAlt;
  logger.info(
    `[queue/alt] Pista do número alternativo iniciada (instância "${numeroAlternativo.instancia()}", ` +
    `teto de ${Math.min(tetoDiario, TETO_MAXIMO)}/dia${rampa.length ? ` depois da rampa ${rampa.join(' → ')}` : ''}, ` +
    `≥ ${(intervaloMinimoMin * 0.6).toFixed(1)} min entre aberturas, ~${espacamentoSeg}s entre envios)`
  );
  setInterval(() => {
    processarAlternativo().catch(err => logger.error('[queue/alt] Passo falhou:', err.message));
  }, POLL_ALT_MS);
}

/** Para testes — processa uma vez. */
export { processBatch };
