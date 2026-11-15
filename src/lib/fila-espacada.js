/**
 * src/lib/fila-espacada.js
 * Uma fila de tarefas com chave, executadas uma de cada vez e com intervalo.
 *
 * É por onde saem os turnos da Leia que o webhook decidiu segurar (ver
 * `resposta-regras.js`): respostas a mensagens que chegaram atrasadas, e o
 * excedente de uma rajada.
 *
 * O que se segura é o TURNO, e não a mensagem pronta. Uma resposta escrita
 * agora e enviada vinte minutos depois sairia cega: sem a mensagem que a
 * pessoa mandou no meio, e por cima do consultor que assumiu a conversa. A
 * tarefa só roda quando chega a vez, e é ela que relê o estado da conversa.
 *
 *   - **Uma por chave.** Entrar de novo com a mesma chave não duplica.
 *   - **`sair(chave)`** tira da fila quem não precisa mais esperar.
 *   - **`podeRodar()`** segura tudo enquanto devolver false (sessão fora do
 *     ar): a fila espera, sem gastar turno com envio que vai falhar.
 *   - **O intervalo só é cobrado de quem enviou.** A tarefa devolve `true`
 *     quando mandou mensagem; turno pulado (conversa em modo humano) não
 *     atrasa o próximo.
 *
 * Em memória, como os buffers do webhook: um restart perde quem estava na
 * fila. As mensagens recebidas já estão gravadas; o que se perde é a
 * resposta automática daquele turno.
 */
import { dormir as dormirDeVerdade, folgaMs } from './ritmo.js';

/**
 * @param {object} [p]
 * @param {() => number} [p.espacamentoSeg] - Intervalo médio entre duas tarefas que enviaram.
 * @param {() => boolean} [p.podeRodar]
 * @param {number} [p.reconferirMs] - De quanto em quanto tempo reler `podeRodar`.
 * @param {(ms: number) => Promise<void>} [p.dormir] - Para o teste.
 * @param {(seg: number) => number} [p.sortear] - Intervalo com folga, em ms.
 * @param {(chave: any, err: Error) => void} [p.aoFalhar]
 */
export function criarFilaEspacada({
  espacamentoSeg = () => 60,
  podeRodar = () => true,
  reconferirMs = 30_000,
  dormir = dormirDeVerdade,
  sortear = (seg) => folgaMs(seg),
  aoFalhar = () => {},
} = {}) {
  const fila = new Map();   // chave -> tarefa, na ordem de entrada
  let rodando = false;

  async function escoar() {
    if (rodando) return;
    rodando = true;
    try {
      while (fila.size) {
        if (!podeRodar()) {
          await dormir(reconferirMs);
          continue;
        }

        const [chave, tarefa] = fila.entries().next().value;
        fila.delete(chave);

        let enviou = false;
        try {
          enviou = (await tarefa()) === true;
        } catch (err) {
          aoFalhar(chave, err);
          // Como no follow-up: a falha pode ter sido depois de a mensagem sair.
          enviou = true;
        }

        if (enviou && fila.size) await dormir(Math.max(0, sortear(espacamentoSeg())));
      }
    } finally {
      rodando = false;
    }
  }

  return {
    /** Põe a tarefa na fila. Devolve false se a chave já estava lá. */
    entrar(chave, tarefa) {
      if (fila.has(chave)) return false;
      fila.set(chave, tarefa);
      escoar().catch(() => {});
      return true;
    },
    tem: (chave) => fila.has(chave),
    sair: (chave) => fila.delete(chave),
    tamanho: () => fila.size,
  };
}
