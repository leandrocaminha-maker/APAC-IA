/**
 * src/services/acompanhamento/aviso-sessoes.js
 * O aviso ao responsável quando a rodada de sessões de domingo falha (decisão
 * 20 de 28/10/2026; PLANO_MODELOS.md do Prescrev, §2.11).
 *
 * O AQUAP roda as sessões da Evo UMA vez por semana: a automática de domingo,
 * 02:00. É dela que sai a verificação da atividade combinada da semana. Se ela
 * falha, a semana fica sem verificação até alguém rodar a manual — e quem
 * precisa saber é o responsável, por WhatsApp.
 *
 *   falha        a partir de domingo, 07:00, o ciclo ainda sem rodada
 *                bem-sucedida: uma mensagem por ciclo, com o motivo da última
 *                tentativa (ou "não rodou", quando nenhuma terminou)
 *   recuperada   depois do aviso de falha, a rodada que terminou bem: uma
 *
 * É mensagem de OPERAÇÃO, e não do acompanhamento: sai também em ensaio
 * (ACOMPANHAMENTO_DRY_RUN) e com os encaminhamentos simulados. O número é
 * `config.acompanhamento.avisoSessoes.telefone`.
 *
 * Quem lê a situação é o Prescrev (`/api/acompanhamento/fichas?so=sessoes`),
 * que a tira do histórico do AQUAP com a mesma regra da trava de lá. Quem
 * guarda o que já foi avisado é o marcador 'acomp:aviso_sessoes'.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { carimbarMarcador, lerMarcador } from '../controle.js';
import { sendText } from '../evolution.js';
import { buscarSituacaoDasSessoes } from './prescrev.js';
import { cicloDe } from './regua.js';

const MARCA = 'acomp:aviso_sessoes';
/** Hora de São Paulo, no domingo, a partir da qual a rodada já devia ter terminado (começa às 02:00, leva ~30 min). */
export const AVISO_SESSOES_HORA = 7;

/** O dia, o dia da semana (0 = domingo) e a hora em São Paulo. */
export function agoraSP(data = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(data).map(x => [x.type, x.value]));
  const dia = `${p.year}-${p.month}-${p.day}`;
  return { dia, semana: new Date(`${dia}T12:00:00Z`).getUTCDay(), hora: Number(p.hour) % 24 };
}

const quando = (iso) => {
  if (!iso) return '—';
  const f = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return f.format(new Date(iso)).replace(', ', ' às ');
};

/**
 * Se o ciclo de hoje já está resolvido — rodada vista, ou falha e recuperação
 * já avisadas —, o worker não pergunta ao Prescrev de novo nesta semana.
 */
export function precisaConferir({ marca, agora }) {
  const ciclo = cicloDe(agora.dia);
  if (agora.semana === 0 && agora.hora < AVISO_SESSOES_HORA) return false;
  if (!marca || marca.ciclo !== ciclo) return true;
  return !marca.ok_visto;
}

/**
 * PURA: o que avisar, dada a situação da semana que o Prescrev publica.
 * @returns {{ tipo: 'falha'|'recuperada'|null, texto: string|null, marca: object }}
 */
export function avisoDasSessoes({ sessoes, marca, agora }) {
  const ciclo = sessoes?.ciclo ?? cicloDe(agora.dia);
  const atual = marca?.ciclo === ciclo ? marca : { ciclo };
  if (!sessoes) return { tipo: null, texto: null, marca: atual };

  if (sessoes.semana_ok) {
    const r = sessoes.rodada;
    if (atual.falha_em && !atual.recuperada_em) {
      return {
        tipo: 'recuperada',
        texto: `Sync de sessões recuperado: a rodada ${r?.origem === 'cron' ? 'automática' : 'manual'} terminou em ${quando(r?.terminou_em)}. ` +
          'A verificação de atividades da semana sai no próximo ensaio.',
        marca: { ...atual, recuperada_em: new Date().toISOString(), ok_visto: true },
      };
    }
    return { tipo: null, texto: null, marca: { ...atual, ok_visto: true } };
  }

  if (atual.falha_em) return { tipo: null, texto: null, marca: atual };
  if (agora.semana === 0 && agora.hora < AVISO_SESSOES_HORA) return { tipo: null, texto: null, marca: atual };
  const t = sessoes.ultima_tentativa;
  const motivo = t && t.ciclo === ciclo && !t.bem_sucedida
    ? `a rodada ${t.origem === 'cron' ? 'automática' : 'manual'} de ${quando(t.terminou_em)} falhou (${t.motivo ?? t.status})`
    : 'nenhuma rodada terminou desde domingo, 02h (o disparo não aconteceu, ou ela ainda está rodando)';
  return {
    tipo: 'falha',
    texto: `O sync de sessões da semana não terminou: ${motivo}. A rodada manual já está liberada no AQUAP, em ` +
      'Sincronização → Sessões da semana. A verificação de atividades da semana espera por ela.',
    marca: { ...atual, falha_em: new Date().toISOString() },
  };
}

/** Confere e, se for o caso, manda. Chamado a cada ciclo do worker; nunca lança. */
export async function conferirSessoesDaSemana(data = new Date()) {
  const telefone = config.acompanhamento.avisoSessoes?.telefone;
  if (!telefone) return null;
  try {
    const agora = agoraSP(data);
    const marca = (await lerMarcador(MARCA))?.valor ?? null;
    if (!precisaConferir({ marca, agora })) return null;
    const sessoes = await buscarSituacaoDasSessoes();
    const r = avisoDasSessoes({ sessoes, marca, agora });
    if (r.tipo) {
      await sendText(telefone, r.texto);
      logger.warn(`[acompanhamento] Aviso de sessões (${r.tipo}) enviado ao responsável.`);
    }
    await carimbarMarcador(MARCA, r.marca);
    return r.tipo;
  } catch (err) {
    logger.warn('[acompanhamento] Aviso de sessões não conferido:', err.message);
    return null;
  }
}
