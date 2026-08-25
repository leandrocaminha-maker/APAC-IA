/**
 * src/workers/campanha-worker.js
 * Worker que regula o disparo das campanhas ativas.
 *
 * Roda como um setInterval dentro do servidor, no mesmo molde do
 * `followup-worker`.
 *
 * ## O que ele faz e o que ele não faz
 *
 * Ele **agenda**. A cada ciclo, para cada campanha ativa, decide quantas
 * mensagens ainda cabem hoje, gera o texto de cada uma e as enfileira em
 * `wa_message_queue` com `scheduled_for` espalhado pelo resto da janela.
 *
 * Ele **não envia**. Quem envia é o `queue-processor`, que já existia. Não
 * há caminho daqui até a Evolution, e portanto não há caminho para um
 * disparo em rajada — nem por bug.
 *
 * ## Três interruptores antes de qualquer coisa sair
 *
 * 1. `CAMPANHA_HABILITADA` (padrão false) — o worker nem inicia.
 * 2. `CAMPANHA_DRY_RUN` (padrão true) — gera e grava o texto, não enfileira.
 * 3. `status = 'ativa'` na campanha — rascunho e pausada são ignoradas.
 *
 * Os padrões são os seguros de propósito: subir o código não liga campanha.
 * Ligar é decisão de alguém, registrada no `.env`.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { campanhasAtivas, processarCampanha, reconciliarEnviados } from '../services/campanhas.js';
import { aiAgent } from '../services/ai-agent.js';

let rodando = false;

/**
 * Gera o texto de uma mensagem para um alvo.
 *
 * Repassa a oferta escrita pelo consultor — é o único fato que a mensagem
 * pode afirmar, porque este caminho não carrega a base de conhecimento.
 */
async function gerarTexto(alvo, campanha) {
  const { text } = await aiAgent.gerarMensagemCampanha({
    alvo,
    oferta: campanha.oferta,
    roteiro: campanha.roteiro,
  });
  return text;
}

async function ciclo() {
  if (rodando) {
    logger.debug('[campanha] Ciclo anterior ainda rodando — pulando');
    return;
  }
  rodando = true;

  try {
    // Primeiro alinha o que a fila já entregou: sem isto o alvo fica
    // eternamente "agendado" e a campanha roda sem medição.
    await reconciliarEnviados().catch(err =>
      logger.warn('[campanha] Reconciliação falhou:', err.message));

    const ativas = await campanhasAtivas();
    if (!ativas.length) return;

    for (const campanha of ativas) {
      try {
        const { agendados, motivo } = await processarCampanha(campanha, gerarTexto);
        if (!agendados && motivo) {
          logger.debug(`[campanha] "${campanha.slug}" parada: ${motivo}`);
        }
      } catch (err) {
        logger.error(`[campanha] "${campanha.slug}" falhou:`, err.message);
      }
    }
  } catch (err) {
    logger.error('[campanha] Ciclo falhou:', err.message);
  } finally {
    rodando = false;
  }
}

/**
 * Inicia o worker. Silencioso e inofensivo quando desligado.
 */
export async function startCampanhaWorker() {
  const minutos = config.campanha.minutos;

  if (!config.crm.habilitado || !config.campanha.habilitada || minutos <= 0) {
    logger.info('[campanha] Worker desligado (CAMPANHA_HABILITADA=false, CAMPANHA_MINUTOS=0 ou CRM desabilitado)');
    return;
  }

  const { error } = await supabase.from('crm_campanhas').select('id').limit(1);
  if (error) {
    logger.warn('[campanha] Não iniciado: crm_campanhas ainda não responde. ' +
      'Rode a migration 005 e reinicie o serviço.');
    return;
  }

  if (config.campanha.dryRun) {
    logger.warn('[campanha] CAMPANHA_DRY_RUN=true — os textos são gerados e gravados, ' +
      'mas NADA é enfileirado nem enviado.');
  } else {
    logger.warn('[campanha] ⚠️ CAMPANHA_DRY_RUN=false — mensagens de campanha VÃO SAIR ' +
      'para clientes reais, respeitando o teto diário de cada campanha.');
  }

  logger.info(`[campanha] Worker iniciado (ciclo a cada ${minutos} min)`);

  // Atraso no boot maior que o do follow-up: o queue-processor e o
  // evo-sync já disputam a partida, e campanha não tem pressa nenhuma.
  setTimeout(ciclo, 120_000);
  setInterval(ciclo, minutos * 60_000);
}

export const campanhaWorker = { startCampanhaWorker };
