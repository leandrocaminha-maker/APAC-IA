/**
 * src/services/vendas-regras.js
 * As regras da venda: o que é plano, quem comprou, por onde chegou e qual
 * atendimento ela fecha.
 *
 * Puro — não lê banco nem EVO. É o que permite testar, e o que garante que
 * o webhook (uma venda por vez, na hora) e a reconstrução do histórico
 * (todas de uma vez) decidam exatamente igual.
 */
import { normalizePhone } from './evolution.js';

const DIA_MS = 24 * 60 * 60 * 1000;
const MES_MS = 30.4 * DIA_MS;

/**
 * Quanto tempo uma conversa no WhatsApp "conta" para a venda que vem depois.
 *
 * É uma escolha, não uma medição: dois meses cobrem quem pensou com calma
 * antes de fechar, sem atribuir ao WhatsApp a compra de quem falou com a
 * gente há meses sobre outro assunto. Atendimento ainda aberto conta
 * sempre, qualquer que seja a idade.
 */
export const JANELA_WHATSAPP_DIAS = 60;

const ETAPAS_FECHADAS = new Set(['ganho', 'perdido', 'finalizado']);

/**
 * Data do EVO como instante de verdade.
 *
 * O EVO manda hora de São Paulo SEM fuso ("2026-10-26T11:22:00", que chega
 * aqui às 14:22 UTC). `new Date` leria isso como hora do processo — UTC no
 * container —, e a venda ficaria três horas adiantada.
 */
export function dataDoEvo(valor) {
  if (valor instanceof Date) return valor;
  const s = String(valor || '').trim();
  if (!s) return new Date(NaN);
  const temFuso = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  return new Date(temFuso ? s : `${s.replace(' ', 'T')}-03:00`);
}

const tempo = (v) => dataDoEvo(v).getTime();
const maisRecente = (a, b) => tempo(b.created_at) - tempo(a.created_at);

/** Soma o `saleValue` dos itens, em reais, sem o resto de ponto flutuante. */
function somaDosItens(itens) {
  const total = itens.reduce((s, item) => s + (Number(item?.saleValue) || 0), 0);
  return Math.round(total * 100) / 100;
}

/**
 * O plano que esta venda fechou, se fechou algum.
 *
 * É o que separa VENDA de compra. Até 26/10/2026 toda venda que não fosse
 * aula experimental fechava o lead como ganho, e o EVO registra como venda
 * tudo o que passa no caixa: touca, maiô, avaliação física.
 *
 * Plano é o item com `idMembership` (contrato), e só conta se os contratos
 * somarem mais que zero. Contrato de R$ 0 é cortesia — "1 SESSÃO PILATES"
 * com 100% de desconto, "FREE PASS 15 DIAS" —, experimental com outro nome.
 *
 * O valor é a soma de TODOS os itens da venda, que é o que a pessoa pagou
 * naquela compra. `saleValue` já vem com desconto e já é o total da linha
 * (duas toucas chegam como um item de R$ 50, não de R$ 25). O topo da venda
 * não tem campo de valor.
 *
 * @returns {{valor: number, planos: string[]} | null}
 */
export function planoDaVenda(detalhe) {
  const itens = detalhe?.saleItens ?? detalhe?.saleItems ?? [];
  if (!Array.isArray(itens) || !itens.length) return null;

  const contratos = itens.filter(item => item?.idMembership);
  if (!contratos.length || somaDosItens(contratos) <= 0) return null;

  return {
    valor: somaDosItens(itens),
    planos: contratos.map(item =>
      String(item.description || item.item || `plano ${item.idMembership}`)
        .replace(/\s*-?\s*In[íi]cio em:.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()),
  };
}

/**
 * Os celulares de um cadastro do EVO, no formato de `crm_leads.phone`.
 *
 * Serve para o membro (`contacts`, como vem de `/members/{id}` e do
 * `CreateMember`). É por aqui que a venda do balcão encontra o lead: ela
 * chega com o número de ALUNO novo, e o lead só conhecia o de prospect.
 */
export function telefonesDoMembro(membro) {
  const contatos = Array.isArray(membro?.contacts) ? membro.contacts : [];
  return [...new Set(contatos
    .filter(c => /cell/i.test(String(c?.contactType || '')) || c?.idContactType === 2)
    .map(c => {
      const numero = String(c?.description || '').replace(/\D/g, '');
      return numero ? normalizePhone(`${c?.ddi || '55'}${numero}`) : null;
    })
    .filter(Boolean))];
}

/**
 * Quem comprou: cliente novo, ex-aluno que voltou, ou aluno ativo.
 *
 * O EVO não responde isso sozinho. A venda traz `idMembershipRenewed`, mas
 * ele aparece também em quem volta depois de um ano parado (o lead 126
 * voltou em 10/09/2026, onze meses depois do último contrato, e veio
 * marcado como renovação). O que decide é o histórico: quando acabou o
 * último contrato PAGO antes deste.
 *
 * Contrato de R$ 0 não conta como "já foi aluno" — é cortesia. E o próprio
 * contrato desta venda fica de fora, pelo `idSale` e por ter começado junto.
 *
 * @param {object} p
 * @param {Array<{idSale, ini, fim, valor}>} p.contratos  histórico normalizado
 * @param {number|string} p.idSale
 * @param {string|Date} p.quando
 * @param {number} p.mesesReativacao  o mesmo EVO_MESES_REATIVACAO da Leia
 */
export function classificarComprador({ contratos, idSale, quando, mesesReativacao }) {
  const t = tempo(quando);
  const anteriores = (contratos || []).filter(c =>
    String(c?.idSale) !== String(idSale)
    && Number(c?.valor) > 0
    && Number.isFinite(tempo(c?.ini))
    && Number.isFinite(tempo(c?.fim))
    && tempo(c.ini) < t - DIA_MS);

  if (!anteriores.length) return { comprador: 'novo', mesesSemContrato: null };

  const ultimoFim = Math.max(...anteriores.map(c => tempo(c.fim)));
  const meses = Math.max(0, (t - ultimoFim) / MES_MS);
  return {
    comprador: meses >= mesesReativacao ? 'ex_aluno' : 'aluno_ativo',
    mesesSemContrato: Math.round(meses * 10) / 10,
  };
}

/** O atendimento já existia quando a venda aconteceu, e é recente o bastante para contar? */
function naJanela(lead, t) {
  const criado = tempo(lead.created_at);
  return criado <= t + DIA_MS && t - criado <= JANELA_WHATSAPP_DIAS * DIA_MS;
}

/** Existia quando a venda aconteceu (com um dia de folga para o mesmo dia). */
function existiaNaVenda(lead, t) {
  return tempo(lead.created_at) <= t + DIA_MS;
}

/**
 * Por onde a venda chegou: WhatsApp ou balcão.
 *
 * WhatsApp é a pessoa ter conversado com a gente por lá ANTES de comprar:
 * um atendimento ainda aberto, ou um que começou nos 60 dias anteriores.
 * Todo o resto é balcão — recepção, telefone, e-mail, indicação.
 *
 * Vale qualquer trilha. Quem comprou pela primeira vez depois de perguntar
 * horário no WhatsApp chegou por lá, mesmo que a conversa tenha sido
 * classificada como relacionamento.
 */
export function canalDaVenda(leads, quando) {
  const t = tempo(quando);
  const veioPeloWhatsapp = (leads || []).some(l =>
    l?.source === 'whatsapp'
    && existiaNaVenda(l, t)
    && (!ETAPAS_FECHADAS.has(l.stage) || naJanela(l, t)));
  return veioPeloWhatsapp ? 'whatsapp' : 'balcao';
}

/**
 * O atendimento que esta venda fecha, e o que fazer com ele.
 *
 * Em ordem:
 *
 * 1. **Um atendimento de venda aberto** → vira ganho. É o caso de todo dia:
 *    a pessoa estava conversando, foi ao balcão e fechou.
 * 2. **Um ganho sem valor** → recebe o valor (`completar`). O poller vê a
 *    conversão antes da venda, e um ganho antigo pode ter sido fechado por
 *    uma compra sem plano.
 * 3. Só para cliente novo e ex-aluno — renovação não reabre nada:
 *    - um ganho com valor na janela → só liga a venda a ele (`vincular`).
 *      É o segundo plano da mesma família, comprado pelo mesmo celular;
 *    - o atendimento mais recente da janela, de venda antes do de
 *      relacionamento → vira ganho. É quem a régua deu por perdido e
 *      comprou depois, e quem teve a conversa arquivada como relacionamento
 *      e era cliente novo.
 *
 * Aluno ativo com atendimento de venda aberto ainda conta como ganho (item
 * 1): é o aluno de musculação que veio pela natação.
 *
 * @returns {{lead: object, acao: 'ganho'|'completar'|'vincular'} | null}
 */
export function escolherLeadDoGanho(leads, { quando, comprador }) {
  const t = tempo(quando);
  const existentes = (leads || []).filter(l => existiaNaVenda(l, t)).sort(maisRecente);

  const aberto = existentes.find(l => (l.trilha || 'lead') === 'lead' && !ETAPAS_FECHADAS.has(l.stage));
  if (aberto) return { lead: aberto, acao: 'ganho' };

  const semValor = existentes.find(l => l.stage === 'ganho' && l.sale_value == null);
  if (semValor) return { lead: semValor, acao: 'completar' };

  if (comprador === 'aluno_ativo') return null;

  const recentes = existentes.filter(l => naJanela(l, t));
  const ganho = recentes.find(l => l.stage === 'ganho');
  if (ganho) return { lead: ganho, acao: 'vincular' };

  const alvo = recentes.find(l => (l.trilha || 'lead') === 'lead') || recentes[0];
  return alvo ? { lead: alvo, acao: 'ganho' } : null;
}

/**
 * Como o vendedor aparece no painel: "Catia Moura", não "CATIA ADRIANA  DE MOURA".
 *
 * O usuário da integração (SUPORTEEVO) é quem registra o que a Leia faz pela
 * API, e aparece como tal.
 */
export function rotuloDoVendedor(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return null;
  if (/^suporte/i.test(partes[0])) return 'Integração (Leia)';
  const titulo = (p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  return partes.length === 1 ? titulo(partes[0]) : `${titulo(partes[0])} ${titulo(partes.at(-1))}`;
}
