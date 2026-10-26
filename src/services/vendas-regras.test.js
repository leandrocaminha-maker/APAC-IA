/**
 * Testes das regras da venda: o que é plano, quem comprou, por onde chegou
 * e qual atendimento ela fecha.
 *
 *   node --test src/services/vendas-regras.test.js
 *
 * Puros: não chamam o EVO nem o banco. Os itens têm o formato do
 * `saleItens` que o ApiCallback devolve, com as descrições reais do caixa,
 * e os casos de atendimento são os encontrados nos dados em 26/10/2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planoDaVenda, classificarComprador, canalDaVenda, escolherLeadDoGanho,
  telefonesDoMembro, rotuloDoVendedor, dataDoEvo,
} from './vendas-regras.js';

const item = (description, saleValue, extra = {}) => ({
  description, saleValue, itemValue: saleValue, quantity: 1, idMembership: null, idService: null, ...extra,
});
const contrato = (description, saleValue, extra = {}) => item(description, saleValue, { idMembership: 559, ...extra });

test('contrato pago fecha, com o valor e o nome do plano sem a data de início', () => {
  const r = planoDaVenda({ saleItens: [contrato('Contrato - ESCOLA NATAÇÃO INICIANTE ANUAL - Início em: 22/10/2026', 2724)] });
  assert.deepEqual(r, { valor: 2724, planos: ['Contrato - ESCOLA NATAÇÃO INICIANTE ANUAL'] });
});

test('o valor é o total da venda, com os itens que vieram junto do plano', () => {
  const r = planoDaVenda({ saleItens: [
    contrato('Contrato - ESTILO DE VIDA PLUS ANUAL (Sessões Ilimitadas) - Início em: 10/09/2026', 3374.4),
    item('Serviço - AF E CONSULTORIA', 0, { idService: 12 }),
    item('Produto - TOUCA PRETA/BRANCA (M)', 25),
  ] });
  assert.equal(r.valor, 3399.4);
  assert.equal(r.planos.length, 1);
});

test('produto sozinho não é venda de plano: touca, maiô', () => {
  assert.equal(planoDaVenda({ saleItens: [
    item('Produto - TOUCA BRANCA/AZUL (P)', 25),
    item('Produto - TOUCA PRETA/VERMELHA ( GG)', 25),
  ] }), null);
  assert.equal(planoDaVenda({ saleItens: [
    item('Produto - MAIÔ ADULTO M', 90),
    item('Produto - TOUCA PRETA/BRANCA (G)', 25),
  ] }), null);
});

test('serviço avulso de R$ 0 não fecha', () => {
  assert.equal(planoDaVenda({ saleItens: [item('Serviço - AF E CONSULTORIA', 0, { idService: 12 })] }), null);
});

test('contrato de R$ 0 é cortesia, não venda', () => {
  assert.equal(planoDaVenda({ saleItens: [
    contrato('Contrato - 1 SESSÃO PILATES FIT STUDIO (1 sessões) - Início em: 28/08/2026', 0, { itemValue: 64, discount: 64 }),
  ] }), null);
  assert.equal(planoDaVenda({ saleItens: [contrato('Contrato - FREE PASS 15 DIAS', 0)] }), null);
});

test('venda sem itens, ou sem detalhe, não fecha', () => {
  assert.equal(planoDaVenda({ saleItens: [] }), null);
  assert.equal(planoDaVenda({}), null);
  assert.equal(planoDaVenda(null), null);
});

test('a soma não deixa resto de ponto flutuante', () => {
  const r = planoDaVenda({ saleItens: [contrato('Contrato - A', 0.1), item('Produto - B', 0.2)] });
  assert.equal(r.valor, 0.3);
});

test('aceita a grafia `saleItems` e valor ausente num item', () => {
  const r = planoDaVenda({ saleItems: [contrato('Contrato - PLANO PRÁTICO', 209), item('Produto - X', undefined)] });
  assert.equal(r.valor, 209);
});

// ── Data do EVO ─────────────────────────────────────────────────────────

test('data do EVO sem fuso é hora de São Paulo', () => {
  assert.equal(dataDoEvo('2026-10-26T11:22:00').toISOString(), '2026-10-26T14:22:00.000Z');
  assert.equal(dataDoEvo('2026-10-26T14:22:03.641+00:00').toISOString(), '2026-10-26T14:22:03.641Z');
  assert.ok(Number.isNaN(dataDoEvo('').getTime()));
});

// ── Quem comprou ────────────────────────────────────────────────────────

const MESES = 3;
const contratoPago = (idSale, ini, fim, valor = 2748) => ({ idSale, ini, fim, valor });

test('sem contrato pago antes desta venda, é cliente novo', () => {
  const r = classificarComprador({
    contratos: [contratoPago(900, '2026-10-02T00:00:00', '2027-10-01T00:00:00', 1512)],
    idSale: 900, quando: '2026-10-02T15:00:00', mesesReativacao: MESES,
  });
  assert.deepEqual(r, { comprador: 'novo', mesesSemContrato: null });
});

test('cortesia de R$ 0 não faz de ninguém ex-aluno', () => {
  const r = classificarComprador({
    contratos: [contratoPago(800, '2026-08-28T00:00:00', '2026-08-31T00:00:00', 0)],
    idSale: 900, quando: '2026-09-10T10:00:00', mesesReativacao: MESES,
  });
  assert.equal(r.comprador, 'novo');
});

test('o lead 126: onze meses sem contrato é ex-aluno, mesmo vindo marcado como renovação', () => {
  const r = classificarComprador({
    contratos: [
      contratoPago(500, '2024-10-01T00:00:00', '2025-09-30T00:00:00', 2748),
      contratoPago(800, '2026-08-28T00:00:00', '2026-08-31T00:00:00', 0),
      contratoPago(900, '2026-09-10T00:00:00', '2027-09-09T00:00:00', 3374.4),
    ],
    idSale: 900, quando: '2026-09-10T10:00:00', mesesReativacao: MESES,
  });
  assert.equal(r.comprador, 'ex_aluno');
  assert.ok(r.mesesSemContrato > 11 && r.mesesSemContrato < 12);
});

test('contrato vencendo agora é aluno ativo renovando', () => {
  const r = classificarComprador({
    contratos: [contratoPago(500, '2025-10-20T00:00:00', '2026-10-19T00:00:00')],
    idSale: 900, quando: '2026-10-21T10:00:00', mesesReativacao: MESES,
  });
  assert.equal(r.comprador, 'aluno_ativo');
});

test('o corte de ex-aluno segue EVO_MESES_REATIVACAO', () => {
  const p = {
    contratos: [contratoPago(500, '2025-04-01T00:00:00', '2026-06-01T00:00:00')],
    idSale: 900, quando: '2026-10-15T10:00:00',
  };
  assert.equal(classificarComprador({ ...p, mesesReativacao: 3 }).comprador, 'ex_aluno');
  assert.equal(classificarComprador({ ...p, mesesReativacao: 6 }).comprador, 'aluno_ativo');
});

// ── Por onde chegou ─────────────────────────────────────────────────────

const lead = (id, created_at, stage, extra = {}) => ({
  id, created_at, stage, trilha: 'lead', source: 'whatsapp', sale_value: null, ...extra,
});

test('conversou no WhatsApp nos 60 dias antes: WhatsApp', () => {
  assert.equal(canalDaVenda([lead(1, '2026-09-01T12:00:00Z', 'perdido')], '2026-10-02T15:00:00'), 'whatsapp');
});

test('conversa encerrada há mais de 60 dias, ou nenhuma: balcão', () => {
  assert.equal(canalDaVenda([lead(1, '2026-06-01T12:00:00Z', 'perdido')], '2026-10-02T15:00:00'), 'balcao');
  assert.equal(canalDaVenda([], '2026-10-02T15:00:00'), 'balcao');
});

test('atendimento aberto conta mesmo antigo; o que começou depois da venda não conta', () => {
  assert.equal(canalDaVenda([lead(1, '2026-06-01T12:00:00Z', 'com_consultor')], '2026-10-02T15:00:00'), 'whatsapp');
  assert.equal(canalDaVenda([lead(1, '2026-10-10T12:00:00Z', 'em_conversa')], '2026-10-02T15:00:00'), 'balcao');
});

test('conversa de relacionamento antes da primeira compra também é WhatsApp', () => {
  const rel = lead(57, '2026-08-24T20:00:00Z', 'finalizado', { trilha: 'relacionamento' });
  assert.equal(canalDaVenda([rel], '2026-08-25T10:00:00'), 'whatsapp');
});

// ── Qual atendimento a venda fecha ──────────────────────────────────────

test('o lead 271: a venda vai para o atendimento ABERTO, não para o ganho falso antigo', () => {
  const r = escolherLeadDoGanho([
    lead(271, '2026-09-02T17:29:00Z', 'ganho'),          // fechado por compra de touca, sem valor
    lead(388, '2026-09-09T12:00:00Z', 'com_consultor'),
  ], { quando: '2026-10-02T15:00:00', comprador: 'novo' });
  assert.equal(r.lead.id, 388);
  assert.equal(r.acao, 'ganho');
});

test('ganho sem valor recebe o valor quando não há atendimento aberto', () => {
  const r = escolherLeadDoGanho([lead(126, '2026-08-26T19:08:00Z', 'ganho')],
    { quando: '2026-09-10T10:00:00', comprador: 'ex_aluno' });
  assert.deepEqual([r.lead.id, r.acao], [126, 'completar']);
});

test('o segundo plano da família só se liga ao ganho que já tem valor', () => {
  const r = escolherLeadDoGanho([lead(545, '2026-09-18T12:00:00Z', 'ganho', { sale_value: 1512 })],
    { quando: '2026-09-26T10:00:00', comprador: 'novo' });
  assert.deepEqual([r.lead.id, r.acao], [545, 'vincular']);
});

test('quem a régua deu por perdido e comprou depois vira ganho', () => {
  const r = escolherLeadDoGanho([lead(513, '2026-09-16T12:00:00Z', 'perdido')],
    { quando: '2026-10-06T10:00:00', comprador: 'novo' });
  assert.deepEqual([r.lead.id, r.acao], [513, 'ganho']);
});

test('na janela, o atendimento de venda vem antes do de relacionamento', () => {
  const r = escolherLeadDoGanho([
    lead(372, '2026-09-08T12:00:00Z', 'perdido'),
    lead(562, '2026-09-21T09:00:00Z', 'finalizado', { trilha: 'relacionamento' }),
  ], { quando: '2026-09-21T15:00:00', comprador: 'novo' });
  assert.equal(r.lead.id, 372);
});

test('cliente novo com conversa só de relacionamento: ela vira o ganho', () => {
  const r = escolherLeadDoGanho([lead(57, '2026-08-24T20:00:00Z', 'finalizado', { trilha: 'relacionamento' })],
    { quando: '2026-08-25T10:00:00', comprador: 'novo' });
  assert.deepEqual([r.lead.id, r.acao], [57, 'ganho']);
});

test('renovação de aluno ativo não reabre atendimento encerrado', () => {
  const leads = [lead(1, '2026-10-01T12:00:00Z', 'finalizado', { trilha: 'relacionamento' })];
  assert.equal(escolherLeadDoGanho(leads, { quando: '2026-10-05T10:00:00', comprador: 'aluno_ativo' }), null);
});

test('aluno ativo com atendimento de venda aberto é ganho (o aluno que veio pela natação)', () => {
  const r = escolherLeadDoGanho([lead(9, '2026-10-01T12:00:00Z', 'experimental_agendada')],
    { quando: '2026-10-05T10:00:00', comprador: 'aluno_ativo' });
  assert.deepEqual([r.lead.id, r.acao], [9, 'ganho']);
});

test('atendimento que começou depois da venda não é dela', () => {
  assert.equal(escolherLeadDoGanho([lead(1, '2026-10-20T12:00:00Z', 'em_conversa')],
    { quando: '2026-10-05T10:00:00', comprador: 'novo' }), null);
});

// ── Telefone e vendedor ─────────────────────────────────────────────────

test('celular do cadastro do EVO no formato do lead; e-mail fica de fora', () => {
  const membro = { contacts: [
    { contactType: 'Cellphone', idContactType: 2, ddi: '55', description: '11961234514' },
    { contactType: 'E-mail', idContactType: 4, description: 'x@y.com' },
  ] };
  assert.deepEqual(telefonesDoMembro(membro), ['5511961234514']);
  assert.deepEqual(telefonesDoMembro(null), []);
});

test('vendedor aparece pelo primeiro e último nome; a integração é a Leia', () => {
  assert.equal(rotuloDoVendedor('CATIA ADRIANA  DE MOURA'), 'Catia Moura');
  assert.equal(rotuloDoVendedor('SUPORTEEVO'), 'Integração (Leia)');
  assert.equal(rotuloDoVendedor(null), null);
});
