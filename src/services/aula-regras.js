/**
 * src/services/aula-regras.js
 * Regras da aula experimental marcada no BALCÃO: qual sessão do EVO é a
 * aula, se o cadastro do EVO pode ser ligado ao atendimento, e o que fazer
 * com a aula vendida que ainda não tem horário reservado.
 *
 * Puras: não chamam o EVO nem o banco. Quem chama é `evo-sync.js`.
 *
 * ## Por que existem (29/10/2026)
 *
 * Nas seis conversas que o responsável mandou analisar, todas tinham aula
 * marcada pela consultora direto no EVO e nenhuma tinha a aula no lead. Sem
 * ela, a régua de silêncio tratava como sumido quem tinha aula marcada, e a
 * Amanda recebeu a mensagem de encerramento três dias antes da aula da
 * Emily. Dois caminhos levavam a isso:
 *
 *  - o cadastro usado no balcão não era conhecido por lead nenhum (a
 *    consultora assumiu antes de a Leia cadastrar, e criou ou reaproveitou
 *    o cadastro lá) — a venda da aula chegava e não achava a quem pertencia;
 *  - a venda chegava antes da reserva (a Shirlei vendeu a aula da Maria
 *    Alice às 9h18 e a mãe escolheu o horário às 9h21) — o sistema procurava
 *    a sessão uma vez só, não achava, e nunca mais olhava.
 */
import { dataDoEvo } from './vendas-regras.js';

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const OFFSET_SP_MS = -3 * HORA_MS;

/** 'AAAA-MM-DD' de São Paulo do instante dado. */
export function diaSP(data) {
  const d = dataDoEvo(data);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + OFFSET_SP_MS).toISOString().slice(0, 10);
}

/**
 * 'AAAA-MM-DD HH:mm' (hora da academia) de uma sessão do EVO, ou `null`.
 *
 * A sessão traz o dia em `date` ("2026-10-24T00:00:00", sempre meia-noite)
 * e a hora à parte, em `startTime` ("10:30").
 */
export function dataHoraDaSessao(sessao) {
  const dia = String(sessao?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;
  const hora = String(sessao?.startTime || '').slice(0, 5);
  return `${dia} ${/^\d{2}:\d{2}$/.test(hora) ? hora : '00:00'}`;
}

/** Instante de uma 'AAAA-MM-DD HH:mm' da academia. */
export function instanteDaAula(dataHora) {
  return dataDoEvo(String(dataHora).replace(' ', 'T') + ':00');
}

/**
 * Qual das sessões da pessoa é a aula que importa agora.
 *
 *  - Só conta sessão do dia `desde` em diante (dia de São Paulo). Aula de
 *    antes é de outra rodada: a Luara tem 10/10 e 24/10, e a venda de 27/10
 *    não é de nenhuma das duas.
 *  - Havendo aula por vir, a mais próxima. Uma hora de folga para trás: a
 *    aula que começou agora ainda é "a de hoje".
 *  - Sem aula por vir, a mais recente — a pessoa fez a aula depois da venda
 *    e antes de alguém olhar.
 *
 * @returns {{ sessao: object, dataHora: string, futura: boolean } | null}
 */
export function escolherSessao(sessoes, { desde = null, agora = new Date() } = {}) {
  const diaMinimo = desde ? diaSP(desde) : null;

  const lista = (Array.isArray(sessoes) ? sessoes : [])
    .map(sessao => ({ sessao, dataHora: dataHoraDaSessao(sessao) }))
    .filter(x => x.dataHora && (!diaMinimo || x.dataHora.slice(0, 10) >= diaMinimo))
    .map(x => ({ ...x, em: instanteDaAula(x.dataHora).getTime() }))
    .filter(x => Number.isFinite(x.em));

  const corte = agora.getTime() - HORA_MS;
  const futuras = lista.filter(x => x.em >= corte).sort((a, b) => a.em - b.em);
  const escolhida = futuras[0] || lista.sort((a, b) => b.em - a.em)[0];
  if (!escolhida) return null;

  return { sessao: escolhida.sessao, dataHora: escolhida.dataHora, futura: escolhida.em >= corte };
}

/**
 * O que fazer com o cadastro do EVO diante do atendimento achado pelo
 * celular desse cadastro.
 *
 *  - `ligar`  — o atendimento não tem cadastro: passa a ter este. Vínculo de
 *    ensaio (id negativo) conta como nenhum.
 *  - `manter` — já é este.
 *  - `outro`  — o atendimento já tem outro cadastro com o mesmo celular (a
 *    mãe conversou sobre hidro e o balcão marcou natação para o filho). Não
 *    troca — decisão do responsável em 29/10/2026. A aula entra assim mesmo.
 */
export function vinculoDoProspect(lead, idProspect) {
  const atual = Number(lead?.evo_id_prospect) || 0;
  if (atual <= 0) return 'ligar';
  return atual === Number(idProspect) ? 'manter' : 'outro';
}

/**
 * Prazos da aula vendida que ainda não tem horário reservado.
 *
 * Três horas para avisar a consultora: dá tempo de ela terminar o que
 * estava fazendo e reservar, e é cedo o bastante para o cliente não ficar
 * esperando — a Duda esperou dois dias e respondeu "não foi confirmado".
 * Sete dias para desistir de procurar: aula experimental marcada para
 * depois disso não é o caso comum, e o aviso já foi dado.
 */
export const AULA_VENDIDA = {
  avisarAposHoras: 3,
  desistirAposDias: 7,
};

/**
 * Próximo passo para a aula vendida sem reserva, depois de mais uma busca
 * que não achou a sessão.
 *
 * @returns {'procurar'|'avisar'|'desistir'}
 */
export function proximoPassoDaAulaVendida(marcador, agora = new Date()) {
  const vendida = dataDoEvo(marcador?.vendida_em || '').getTime();
  if (!Number.isFinite(vendida)) return 'desistir';

  const idade = agora.getTime() - vendida;
  if (idade >= AULA_VENDIDA.desistirAposDias * DIA_MS) return 'desistir';
  if (!marcador.avisado_em && idade >= AULA_VENDIDA.avisarAposHoras * HORA_MS) return 'avisar';
  return 'procurar';
}

/**
 * Quando a venda aconteceu: `saleDate` do detalhe (hora de São Paulo sem
 * fuso), ou a chegada do webhook quando o detalhe não diz.
 */
export function instanteDaVenda(detalhe, evento) {
  const daVenda = dataDoEvo(detalhe?.saleDate || '');
  if (Number.isFinite(daVenda.getTime())) return daVenda;
  const doEvento = dataDoEvo(evento?.created_at || '');
  return Number.isFinite(doEvento.getTime()) ? doEvento : new Date();
}

/** Começo da nota que o aviso de "aula sem reserva" põe na próxima ação. */
export const NOTA_SEM_RESERVA = 'Aula experimental vendida no EVO';
