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
 *
 * ## O recomeço depois de uma restrição
 *
 * O teto de regime não vale no dia em que o número volta de uma restrição.
 * Em 16/11/2026 valeu: o número tinha voltado na véspera, a segunda-feira
 * gastou os 38 do teto até as 13h35, e a Meta restringiu de novo às 17h57.
 * Desde então a cota de hoje é o menor entre o regime e o degrau do
 * recomeço (`recomeco.js`): zero enquanto o número está fora e nos primeiros
 * dias da volta, e depois a rampa de `ENVIO_RECOMECO_RAMPA`.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { diasDeUso, tetoDoDia } from './pesquisa-regras.js';
import { recomeco } from './recomeco.js';
import { tetoDeHoje } from './recomeco-regras.js';

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
 *
 * `bot:acompanhamento` é a mensagem da régua do acompanhamento: quem
 * começa somos nós, e ela conta (D5 — o sub-teto dela é à parte, e por
 * dentro deste). O aceite do ATIVAR e a Leia do acompanhamento
 * (`bot:acompanhamento:aceite`, `:leia`) respondem a quem escreveu, e o
 * `eq` os deixa de fora.
 *
 * `bot:avaliacao` (os avisos da avaliação física, `avaliacao-avisos.js`)
 * fica FORA do teto, por decisão do responsável em 03/11/2026: é aviso a
 * quem tem horário marcado, e no dia em que o teto bateu às 10h17 (34
 * follow-ups represados do domingo e do feriado) o lembrete da véspera
 * esperaria atrás das retomadas de venda até passar do prazo de desmarcar.
 * Ele não conta e não consulta o teto.
 */
const AUTOMATICOS = 'sent_by.eq.bot:followup,sent_by.like.app:*,sent_by.eq.bot:acompanhamento';

/**
 * O que a RAMPA do recomeço conta: o mesmo, menos o acompanhamento.
 *
 * Decisão do responsável em 16/11/2026: as mensagens do acompanhamento (e os
 * avisos da avaliação, que já ficam fora do teto) saem desde a reconexão,
 * sem esperar a rampa. Elas continuam no teto de regime, mas não gastam o
 * degrau do dia — senão os 7 do acompanhamento comeriam os 5 do quarto dia
 * e o follow-up não sairia.
 */
const AUTOMATICOS_DA_RAMPA = 'sent_by.eq.bot:followup,sent_by.like.app:*';

/**
 * Quantas conversas a máquina já iniciou hoje.
 *
 * @param {Date} [agora]
 * @param {{ daRampa?: boolean }} [opcoes] - `daRampa` conta só o que a rampa conta.
 * @returns {Promise<number|null>} `null` quando a consulta falhou — quem
 *   chama trata isso como "não pode enviar", nunca como zero.
 */
export async function usadosHoje(agora = new Date(), { daRampa = false } = {}) {
  const { count, error } = await supabase
    .from('wa_messages')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .gte('created_at', inicioDoDiaSP(agora).toISOString())
    .or(daRampa ? AUTOMATICOS_DA_RAMPA : AUTOMATICOS);

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
 * Em recomeço (`recomeco.js`) o teto do dia é o degrau da rampa, e vale
 * mesmo com o teto de regime desligado. `recomeco` volta preenchido só
 * nesse caso, para quem precisa saber por que a cota está menor.
 *
 * `liberadoNoRecomeco` é o acompanhamento (decisão de 16/11/2026): depois
 * que o número volta, ele não espera a rampa — só o teto de regime. Enquanto
 * o número está fora do ar, nem ele sai.
 *
 * Em recomeço o degrau conta só o que a rampa conta (`AUTOMATICOS_DA_RAMPA`),
 * e o teto de regime continua contando tudo: vale o menor dos dois.
 *
 * @param {Date} [agora]
 * @param {{ liberadoNoRecomeco?: boolean }} [opcoes]
 * @returns {Promise<{ok: boolean, teto: number, usados: number|null, restante: number, motivo?: string, recomeco?: object}>}
 */
export async function cota(agora = new Date(), { liberadoNoRecomeco = false } = {}) {
  let situacao = await recomeco.situacao(agora);
  const numeroVoltou = situacao.dia != null;
  if (liberadoNoRecomeco && situacao.ativo && numeroVoltou && !situacao.indisponivel) {
    situacao = { ativo: false, dia: situacao.dia, teto: null };
  }

  const regime = config.envio.tetoDiario > 0 ? config.envio.tetoDiario : Infinity;
  const degrau = situacao.ativo ? tetoDeHoje(regime === Infinity ? 0 : regime, situacao) : Infinity;

  if (regime === Infinity && degrau === Infinity) {
    return { ok: true, teto: 0, usados: null, restante: Infinity, motivo: 'teto desligado' };
  }

  // Recomeço com degrau zero (ou marcador ilegível): nada a contar.
  if (degrau <= 0) {
    return { ok: false, teto: 0, usados: null, restante: 0, motivo: situacao.motivo, recomeco: situacao };
  }

  const [usados, daRampa] = await Promise.all([
    regime === Infinity ? 0 : usadosHoje(agora),
    degrau === Infinity ? 0 : usadosHoje(agora, { daRampa: true }),
  ]);

  if (usados === null || daRampa === null) {
    return {
      ok: false, teto: Math.min(regime, degrau), usados: null, restante: 0,
      motivo: 'a contagem do dia falhou — nada sai enquanto o teto não puder ser conferido',
    };
  }

  const restanteRegime = regime - usados;
  const restanteDegrau = degrau - daRampa;
  const peloDegrau = restanteDegrau < restanteRegime;
  const restante = Math.min(restanteRegime, restanteDegrau);
  const teto = peloDegrau ? degrau : regime;
  const usadosQueValem = peloDegrau ? daRampa : usados;

  return {
    ok: restante > 0,
    teto,
    usados: usadosQueValem,
    restante: Math.max(restante, 0),
    motivo: restante > 0
      ? undefined
      : peloDegrau
        ? `${situacao.motivo} — atingido (${daRampa}/${degrau})`
        : `teto diário do número atingido (${usados}/${regime})`,
    ...(situacao.ativo ? { recomeco: situacao } : {}),
  };
}

/** Atalho de leitura: só o booleano e o motivo. */
export async function podeIniciarConversa(agora = new Date(), opcoes = {}) {
  const { ok, motivo } = await cota(agora, opcoes);
  return { ok, motivo };
}

/** A cota do acompanhamento: depois da reconexão, só o teto de regime. */
export function podeIniciarAcompanhamento(agora = new Date()) {
  return podeIniciarConversa(agora, { liberadoNoRecomeco: true });
}

/**
 * A cota do dia do NÚMERO ALTERNATIVO — outra conta, que não soma com a de
 * cima nem tira dela.
 *
 * Conta as ABERTURAS que a instância fez hoje, em `wa_alt_mensagens`. O link
 * e as respostas fixas vão para conversa que já existe, e não contam — o
 * mesmo critério do teto principal, que deixa a resposta de fora.
 *
 * O teto não é um número só: nos primeiros dias da instância vale a rampa
 * (`ENVIO_ALT_RAMPA`), contada da primeira abertura dela. Número novo com o
 * teto cheio no primeiro dia é o que mais cai.
 *
 * Falha fechada, como `cota`: sem conseguir contar, nada sai.
 *
 * @returns {Promise<{ok: boolean, teto: number, usados: number|null, restante: number, dia: number|null, motivo?: string}>}
 */
export async function cotaAlternativo(agora = new Date()) {
  const instancia = config.evolution.instanciaAlt;
  if (!instancia) {
    return {
      ok: false, teto: 0, usados: null, restante: 0, dia: null,
      motivo: 'número alternativo não configurado (EVOLUTION_INSTANCE_ALT)',
    };
  }

  const aberturas = () => supabase
    .from('wa_alt_mensagens')
    .select('created_at', { count: 'exact' })
    .eq('instancia', instancia)
    .eq('direction', 'outbound')
    .eq('tipo', 'abertura');

  const [primeira, hoje] = await Promise.all([
    aberturas().order('created_at', { ascending: true }).limit(1),
    aberturas().gte('created_at', inicioDoDiaSP(agora).toISOString()).limit(1),
  ]);

  const erro = primeira.error || hoje.error;
  if (erro) {
    logger.error('[limite] Não foi possível contar os envios do número alternativo:', erro.message);
    return {
      ok: false, teto: 0, usados: null, restante: 0, dia: null,
      motivo: 'a contagem do número alternativo falhou — nada sai por ele enquanto o teto não puder ser conferido',
    };
  }

  const dia = diasDeUso(primeira.data?.[0]?.created_at ?? null, agora);
  const teto = tetoDoDia(dia, config.envioAlt);
  const usados = hoje.count ?? 0;
  const restante = Math.max(teto - usados, 0);

  return {
    ok: restante > 0,
    teto,
    usados,
    restante,
    dia,
    motivo: restante > 0
      ? undefined
      : `teto diário do número alternativo atingido (${usados}/${teto}, dia ${dia + 1} de uso)`,
  };
}

export const limiteEnvio = { cota, cotaAlternativo, podeIniciarConversa, podeIniciarAcompanhamento, usadosHoje, inicioDoDiaSP };
