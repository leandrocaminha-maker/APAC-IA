/**
 * src/workers/acompanhamento-worker.js
 * Roda, uma vez por dia, a régua do acompanhamento (ensaio, ou a rodada de
 * envio); e, a cada ACOMPANHAMENTO_ENCAMINHAMENTOS_MINUTOS, o envio do que
 * chegou à hora (envio.js, só com o envio real ligado) e a fila e os prazos
 * dos encaminhamentos à equipe — que só saem no horário de quem recebe.
 *
 * Mesmo molde do `campanha-worker`: um setInterval dentro do servidor, que
 * a cada `ACOMPANHAMENTO_MINUTOS` confere se o ensaio de hoje já rodou
 * (marcador 'acomp:ensaio' em `crm_controle`, que sobrevive a restart) e,
 * passada a `ACOMPANHAMENTO_HORA`, roda.
 *
 * ## Três interruptores
 *
 * 1. `ACOMPANHAMENTO_HABILITADO` (padrão false) — o worker nem inicia.
 * 2. `ACOMPANHAMENTO_DRY_RUN` (padrão true) — ensaio: a régua grava o que
 *    sairia e nada vai ao aluno. Com false, ENVIO REAL (A5c): só para quem
 *    ativou o WhatsApp, reconferido antes de cada mensagem. É a chave do
 *    início, que o responsável declara.
 * 3. `ACOMPANHAMENTO_SECRET` — sem ele não há como buscar as fichas.
 *
 * Os padrões são os seguros de propósito: subir o código não liga nada.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { hojeSP } from '../services/campanhas.js';
import { modoAtual, rodarEnsaio, ultimaRodada } from '../services/acompanhamento/ensaio.js';
import { enviarDisparos } from '../services/acompanhamento/envio.js';
import { processarEncaminhamentos } from '../services/acompanhamento/encaminhamentos.js';
import { processarPontes } from '../services/acompanhamento/ponte.js';

let rodando = false;

function horaSP(data = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false,
  }).format(data));
}

async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    if (horaSP() < config.acompanhamento.hora) return;
    const marca = await ultimaRodada();
    // O dia já rodou neste modo. Ligar o envio no meio do dia faz rodar de
    // novo, agora como envio.
    if (marca?.valor?.dia === hojeSP() && (marca.valor.modo ?? 'ensaio') === modoAtual()) return;
    await rodarEnsaio({ origem: 'worker' });
  } catch (err) {
    logger.error('[acompanhamento] Ensaio falhou:', err.message);
  } finally {
    rodando = false;
  }
}

/**
 * Os encaminhamentos andam em ciclo próprio, mais curto: o que esperava o
 * turno de quem recebe sai, e o que passou do prazo sem "1" vai à
 * coordenação. O prazo de "hoje" é de 2 horas de trabalho.
 */
let encaminhando = false;
async function cicloDosEncaminhamentos() {
  if (encaminhando) return;
  encaminhando = true;
  try {
    await enviarDisparos().catch(err => logger.warn('[acompanhamento] Envio:', err.message));
    await processarEncaminhamentos();
    // A ponte (A5d): o que o aluno mandou fora do turno do professor sai no
    // começo do turno, e a ponte sem mensagem há 72 h fecha.
    await processarPontes().catch(err => logger.warn('[acompanhamento] Ponte:', err.message));
  } catch (err) {
    logger.warn('[acompanhamento] Encaminhamentos:', err.message);
  } finally {
    encaminhando = false;
  }
}

/** Inicia o worker. Silencioso e inofensivo quando desligado. */
export async function startAcompanhamentoWorker() {
  const c = config.acompanhamento;

  if (!c.habilitado || c.minutos <= 0) {
    logger.info('[acompanhamento] Worker desligado (ACOMPANHAMENTO_HABILITADO=false ou ACOMPANHAMENTO_MINUTOS=0)');
    return;
  }
  if (!c.prescrev.segredo) {
    logger.warn('[acompanhamento] Worker não iniciado: falta ACOMPANHAMENTO_SECRET (o mesmo do Prescrev).');
    return;
  }

  const { error } = await supabase.from('acomp_disparos').select('id').limit(1);
  if (error) {
    logger.warn('[acompanhamento] Worker não iniciado: acomp_disparos ainda não responde. ' +
      'Rode a migration 011 e reinicie o serviço.');
    return;
  }

  if (c.dryRun) {
    logger.warn('[acompanhamento] Em ENSAIO — a régua decide e grava o que sairia; nada é enviado.');
  } else {
    logger.warn(`[acompanhamento] ENVIO REAL ligado — a régua manda para quem ativou o WhatsApp, até ${c.tetoDiario} por dia.` +
      (c.encaminhamentosReais ? ' Encaminhamentos reais.' : ' Encaminhamentos ainda simulados.'));
  }
  logger.info(`[acompanhamento] Worker iniciado (confere a cada ${c.minutos} min, roda a partir das ${c.hora}h)`);

  setTimeout(ciclo, 150_000);
  setInterval(ciclo, c.minutos * 60_000);
  if (c.encaminhamentosMinutos > 0) {
    setTimeout(cicloDosEncaminhamentos, 60_000);
    setInterval(cicloDosEncaminhamentos, c.encaminhamentosMinutos * 60_000);
    logger.info(`[acompanhamento] Encaminhamentos: fila e prazos a cada ${c.encaminhamentosMinutos} min, só no horário de quem recebe`);
  }
}

export const acompanhamentoWorker = { startAcompanhamentoWorker };
