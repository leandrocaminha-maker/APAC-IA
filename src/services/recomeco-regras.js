/**
 * src/services/recomeco-regras.js
 * O recomeço depois de uma restrição da Meta — as regras, sem banco.
 *
 * ## Por que existe
 *
 * Em 16/11/2026 a Meta restringiu o número principal pela segunda vez em
 * três dias. O número tinha voltado em 15/11 às 17h01, e a segunda-feira
 * correu em regime: a régua de silêncio, o acompanhamento e os avisos
 * abriram 50 conversas com quem não escrevia havia mais de 24 h — 25 delas
 * entre 9h e 10h —, e a sessão caiu 32 s depois da última. Sem rajada: a pista
 * segurou o ritmo (no máximo 4 envios num minuto). O que faltou foi o
 * recomeço. O teto do número seguia em 38, o valor de regime, porque baixar
 * depois de uma restrição dependia de alguém lembrar de editar o `.env`.
 *
 * Aqui a restrição vira um fato gravado (`recomeco.js`), e o teto do dia
 * passa a sair de uma rampa contada do dia em que o número voltou.
 *
 * ## O que a rampa é
 *
 * Um teto por dia corrido, contado do dia da volta (dia 1 = o dia em que a
 * sessão reconectou). Enquanto o número não volta, o teto é zero. Passado o
 * último degrau, vale o teto de regime (`ENVIO_TETO_DIARIO`). O degrau nunca
 * passa do regime.
 */

// O Brasil não tem horário de verão desde 2019 — mesma constante, pelo mesmo
// motivo, de `limite-envio.js`.
const OFFSET_SP_MS = -3 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
const diaSP = (quando) => Math.floor((new Date(quando).getTime() + OFFSET_SP_MS) / DIA_MS);

/**
 * Códigos com que a sessão cai e a Evolution NÃO reconecta sozinha: 401 é o
 * aparelho removido (`device_removed`, o que a Meta manda ao restringir — e
 * também o que chega quando alguém tira o aparelho pelo celular), 403 é
 * conta banida. Queda de rede e `stream errored` reconectam e não entram.
 */
export const CODIGOS_DE_QUEDA = [401, 402, 403, 406];

/**
 * Duas leituras da mesma queda não batem no segundo: o webhook carimba a
 * hora em que o aviso chegou, e a conferência com a Evolution lê a hora que
 * ela gravou. Dentro desta folga é a mesma queda.
 */
const FOLGA_MESMA_QUEDA_MS = 5 * 60 * 1000;

/** `"0,0,0,5,10"` → `[0, 0, 0, 5, 10]`. Vazio (ou só lixo) desliga a rampa. */
export function lerRampa(texto) {
  return String(texto ?? '')
    .split(',')
    .map(v => v.trim())
    .filter(v => v !== '')
    .map(Number)
    .filter(v => Number.isFinite(v) && v >= 0)
    .map(Math.floor);
}

/** dd/mm de São Paulo. */
function diaMes(quando) {
  const d = new Date(new Date(quando).getTime() + OFFSET_SP_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Esta queda é outra, ou a que já está gravada?
 *
 * @param {{em?: string}|null} gravada
 * @param {string|Date} em - Quando a queda aconteceu.
 */
export function ehQuedaNova(gravada, em) {
  const nova = new Date(em).getTime();
  if (!Number.isFinite(nova)) return false;
  const antiga = gravada?.em ? new Date(gravada.em).getTime() : NaN;
  if (!Number.isFinite(antiga)) return true;
  return nova > antiga + FOLGA_MESMA_QUEDA_MS;
}

/**
 * Em que ponto do recomeço o número está.
 *
 * @param {object} p
 * @param {{em: string, voltou_em?: string|null, encerrado_em?: string|null}|null} p.restricao
 * @param {number[]} p.rampa - Um teto por dia, do dia da volta em diante.
 * @param {Date} [p.agora]
 * @returns {{ativo: boolean, dia: number|null, teto: number|null, motivo?: string}}
 *   `dia` começa em 0 no dia da volta; `teto` é o do dia, sem o corte do regime.
 */
export function situacaoDoRecomeco({ restricao, rampa = [], agora = new Date() } = {}) {
  const fora = { ativo: false, dia: null, teto: null };
  if (!restricao?.em || restricao.encerrado_em || !rampa.length) return fora;

  const quando = diaMes(restricao.em);

  if (!restricao.voltou_em) {
    return {
      ativo: true, dia: null, teto: 0,
      motivo: `número derrubado pelo WhatsApp em ${quando} e ainda fora do ar — a máquina não inicia conversa`,
    };
  }

  const dia = Math.max(0, diaSP(agora) - diaSP(restricao.voltou_em));
  if (dia >= rampa.length) return { ...fora, dia };

  const teto = rampa[dia];
  const etapa = `recomeço depois da restrição de ${quando} (dia ${dia + 1} de ${rampa.length})`;
  return {
    ativo: true, dia, teto,
    motivo: teto > 0
      ? `${etapa}: teto de ${teto} conversa(s) iniciada(s) hoje`
      : `${etapa}: a máquina não inicia conversa hoje`,
  };
}

/**
 * O teto que vale hoje, juntando o regime e o recomeço.
 *
 * O degrau nunca passa do regime. Com o teto de regime desligado (0), o
 * recomeço vale assim mesmo: desligar o teto não pode desligar a rampa.
 *
 * @returns {number} `Infinity` quando não há teto nenhum.
 */
export function tetoDeHoje(tetoRegime, situacao) {
  const regime = Number(tetoRegime) > 0 ? Number(tetoRegime) : Infinity;
  if (!situacao?.ativo) return regime;
  return Math.min(regime, Math.max(0, Number(situacao.teto) || 0));
}
