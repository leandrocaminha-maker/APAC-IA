/**
 * src/services/limite-envio.js
 * O teto diário do NÚMERO — a conta que faltava.
 *
 * ## Por que existe
 *
 * Até 31/08/2026 cada subsistema tinha o seu próprio teto e nenhum sabia do
 * outro: a campanha parava em 40/dia, a régua de silêncio em 15 por
 * varredura (de hora em hora), e o follow-up de venda não tinha teto
 * nenhum. Cada um era razoável sozinho. Somados, davam mais de cem
 * aberturas de conversa por dia saindo do mesmo número — e "conversas
 * novas iniciadas" é exatamente o contador que a Meta mede. Em 31/08 ela
 * restringiu a conta por isso.
 *
 * Este módulo é o único lugar que enxerga a soma.
 *
 * ## O que conta e o que não conta
 *
 * Conta o que a máquina INICIA: follow-up (`bot:followup`) e tudo que sai
 * pela fila (`app:*` — campanha e apps irmãos).
 *
 * NÃO conta resposta a mensagem recebida (`bot`) nem fala de consultor
 * (`human:*`). A própria tela de restrição diz que responder segue
 * liberado; capar resposta faria a academia parecer muda sem reduzir em
 * nada o comportamento que gerou o bloqueio.
 *
 * ## A fonte é `wa_messages`, não um contador
 *
 * Um contador próprio seria mais barato e seria uma segunda verdade sobre
 * o mesmo fato — e as duas divergem no primeiro erro de gravação. Aqui a
 * conta é feita sobre o que efetivamente saiu, que é o que a Meta também
 * conta. O volume é de centenas de linhas por dia, com índice em
 * `created_at`: a consulta é irrelevante perto de uma chamada ao modelo.
 *
 * ## Falha fechada, de propósito
 *
 * Se a consulta falhar, ninguém inicia conversa. Um dispositivo de
 * segurança que falha aberto não é dispositivo de segurança — e o custo do
 * erro é assimétrico: uma hora de follow-up atrasado contra uma segunda
 * restrição no número principal da academia.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

// O Brasil aboliu o horário de verão em 2019 — São Paulo é UTC-3 o ano
// todo. Mesma constante isolada de `followup.js`, pelo mesmo motivo: se um
// dia voltar, é um lugar só para mexer em cada arquivo.
const OFFSET_SP_MS = -3 * 60 * 60 * 1000;

/** Meia-noite de São Paulo do dia em que `agora` cai, como Date UTC. */
export function inicioDoDiaSP(agora = new Date()) {
  const d = new Date(agora.getTime() + OFFSET_SP_MS);
  const meiaNoite = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(meiaNoite - OFFSET_SP_MS);
}

/**
 * Filtro PostgREST do que é envio automático iniciado por nós.
 *
 * `app:*` cobre `app:campanha:<slug>` e os apps irmãos de uma vez — o
 * `queue-processor` grava todos com esse prefixo. No PostgREST o curinga
 * do `like` é `*`, não `%`.
 */
const AUTOMATICOS = 'sent_by.eq.bot:followup,sent_by.like.app:*';

/**
 * Quantas conversas a máquina já iniciou hoje.
 *
 * @returns {Promise<number|null>} `null` quando a consulta falhou — quem
 *   chama trata isso como "não pode enviar", nunca como zero.
 */
export async function usadosHoje(agora = new Date()) {
  const { count, error } = await supabase
    .from('wa_messages')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .gte('created_at', inicioDoDiaSP(agora).toISOString())
    .or(AUTOMATICOS);

  if (error) {
    logger.error('[limite] Não foi possível contar os envios de hoje:', error.message);
    return null;
  }
  return count ?? 0;
}

/**
 * A cota do dia. Chame antes de CADA envio automático.
 *
 * `ENVIO_TETO_DIARIO=0` desliga o teto — e é assim que se volta ao
 * comportamento que causou a restrição, então que seja uma decisão escrita
 * no `.env` e não um efeito colateral.
 *
 * @returns {Promise<{ok: boolean, teto: number, usados: number|null, restante: number, motivo?: string}>}
 */
export async function cota(agora = new Date()) {
  const teto = config.envio.tetoDiario;

  if (teto <= 0) {
    return { ok: true, teto: 0, usados: null, restante: Infinity, motivo: 'teto desligado' };
  }

  const usados = await usadosHoje(agora);

  if (usados === null) {
    return {
      ok: false, teto, usados: null, restante: 0,
      motivo: 'a contagem do dia falhou — nada sai enquanto o teto não puder ser conferido',
    };
  }

  const restante = teto - usados;
  return {
    ok: restante > 0,
    teto,
    usados,
    restante: Math.max(restante, 0),
    motivo: restante > 0 ? undefined : `teto diário do número atingido (${usados}/${teto})`,
  };
}

/** Atalho de leitura: só o booleano e o motivo. */
export async function podeIniciarConversa(agora = new Date()) {
  const { ok, motivo } = await cota(agora);
  return { ok, motivo };
}

export const limiteEnvio = { cota, podeIniciarConversa, usadosHoje, inicioDoDiaSP };
