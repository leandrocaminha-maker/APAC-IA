/**
 * src/lib/pista-envio.js
 * A pista de envio: tudo que sai de um número passa por aqui, um de cada vez.
 *
 * ## Por que existe
 *
 * Em 14/11/2026 a sessão voltou de uma falha de 20 horas e o WhatsApp
 * entregou de uma vez 104 mensagens represadas. A Leia respondeu 23
 * conversas em 36 segundos, com 20 chats "digitando" ao mesmo tempo, e a
 * Meta restringiu o número. Em 30 dias de operação normal o máximo tinha
 * sido 6 respostas num minuto.
 *
 * Todas as proteções que existiam — teto diário, espaçamento de 75 s,
 * janela de contato — moram nos caminhos em que a MÁQUINA inicia a conversa
 * (fila, follow-up, campanha), cada uma dentro do seu laço. A resposta a
 * quem escreveu ficava de fora de propósito ("responder segue liberado"), e
 * cada conversa respondia por conta própria, sem saber das outras.
 *
 * É a mesma lição da cota do EVO (`evoFetch`): o limite é da conta inteira,
 * e throttle por chamador não sabe do outro. Por isso a pista fica no único
 * ponto por onde todo envio passa, `evolution.js`, e não em cada laço.
 *
 * ## O que ela garante
 *
 *   - **Um envio por vez.** O "digitando" faz parte do envio (a Evolution
 *     segura a chamada por esse tempo), então dois chats nunca digitam
 *     juntos — que é o que uma pessoa com um celular consegue fazer.
 *   - **Um piso entre dois envios**, com folga aleatória.
 *   - **Um teto por minuto.** Passou disso, o próximo espera a janela andar.
 *
 * Não é teto diário nem decide QUEM pode receber: isso continua em
 * `limite-envio.js` e nos workers. Aqui só se decide QUANDO sai.
 *
 * ## Prioridade
 *
 * `alta` passa na frente de quem está esperando (não de quem já está
 * saindo). É o consultor escrevendo pelo painel: ele está olhando a tela, e
 * não pode ficar atrás de uma fila de respostas automáticas.
 *
 * ## Em memória
 *
 * Como os buffers do webhook: um restart perde o que estava esperando na
 * pista. Quem chamou recebe o erro e trata como falha de envio.
 */
import { dormir as dormirDeVerdade, folgaMs } from './ritmo.js';

const JANELA_MS = 60_000;

/**
 * Quanto falta para o próximo envio poder sair, em ms.
 *
 * Função pura, para o teste: recebe o relógio e o que já saiu.
 *
 * @param {object} p
 * @param {number} p.agora
 * @param {number|null} p.ultimoFim - Quando o envio anterior terminou.
 * @param {number} p.intervaloMs - Piso sorteado para este envio.
 * @param {number[]} p.saidas - Instantes dos envios do último minuto, em ordem.
 * @param {number} p.maxPorMinuto - 0 desliga o teto.
 */
export function esperaMs({ agora, ultimoFim, intervaloMs, saidas, maxPorMinuto }) {
  let espera = 0;

  if (ultimoFim != null) {
    espera = Math.max(espera, ultimoFim + intervaloMs - agora);
  }

  if (maxPorMinuto > 0) {
    const recentes = saidas.filter(t => agora - t < JANELA_MS);
    if (recentes.length >= maxPorMinuto) {
      // Só cabe mais um quando o mais antigo dos que contam sair da janela.
      const libera = recentes[recentes.length - maxPorMinuto] + JANELA_MS;
      espera = Math.max(espera, libera - agora);
    }
  }

  return Math.max(0, espera);
}

/**
 * Cria uma pista.
 *
 * @param {object} [p]
 * @param {() => number} [p.intervaloSeg] - Piso médio entre envios, em segundos.
 * @param {() => number} [p.maxPorMinuto]
 * @param {() => number} [p.agora] - Relógio (para o teste).
 * @param {(ms: number) => Promise<void>} [p.dormir] - Para o teste.
 * @param {(seg: number) => number} [p.sortear] - Piso com folga, em ms.
 */
export function criarPista({
  intervaloSeg = () => 4,
  maxPorMinuto = () => 6,
  agora = Date.now,
  dormir = dormirDeVerdade,
  sortear = (seg) => folgaMs(seg),
} = {}) {
  const fila = [];
  let saidas = [];
  let ultimoFim = null;
  let rodando = false;

  async function escoar() {
    if (rodando) return;
    rodando = true;
    try {
      while (fila.length) {
        const espera = esperaMs({
          agora: agora(),
          ultimoFim,
          intervaloMs: Math.max(0, sortear(intervaloSeg())),
          saidas,
          maxPorMinuto: maxPorMinuto(),
        });
        if (espera > 0) await dormir(espera);

        // Só agora se escolhe quem sai: durante a espera pode ter entrado
        // alguém com prioridade.
        const item = fila.shift();
        if (!item) break;

        try {
          item.resolve(await item.fn({ esperouMs: agora() - item.entrouEm, naFila: fila.length }));
        } catch (err) {
          item.reject(err);
        }

        // Conta mesmo quando falhou: a falha pode ter sido DEPOIS de a
        // mensagem sair, e um intervalo desperdiçado custa menos que uma
        // rajada.
        ultimoFim = agora();
        saidas = [...saidas.filter(t => ultimoFim - t < JANELA_MS), ultimoFim];
      }
    } finally {
      rodando = false;
    }
  }

  /**
   * Põe um envio na pista e devolve o resultado dele.
   *
   * @param {(info: {esperouMs: number, naFila: number}) => Promise<any>} fn
   * @param {object} [opts]
   * @param {'alta'|'normal'} [opts.prioridade]
   */
  function passar(fn, { prioridade = 'normal' } = {}) {
    return new Promise((resolve, reject) => {
      const item = { fn, resolve, reject, prioridade, entrouEm: agora() };

      if (prioridade === 'alta') {
        // Depois das outras altas, antes da primeira normal.
        const i = fila.findIndex(x => x.prioridade !== 'alta');
        if (i === -1) fila.push(item);
        else fila.splice(i, 0, item);
      } else {
        fila.push(item);
      }

      escoar().catch(() => {});
    });
  }

  return {
    passar,
    /** Quantos envios estão esperando (sem contar o que está saindo). */
    tamanho: () => fila.length,
  };
}
