/**
 * Testes da régua e do preenchimento do acompanhamento.
 *
 *   node --test src/services/acompanhamento/
 *
 * Puros: não leem `.env` nem banco. Os modelos e a ficha abaixo têm a forma
 * do que o Prescrev publica (/api/acompanhamento/modelos e /fichas).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diasEntre, preencher, valoresDaFicha } from './render.js';
import { candidatosDe, decidir, emRodizio, horaPrevista, situacaoDoDia } from './regua.js';

const ficha = (mudar = {}) => ({
  cliente_id: 'c1',
  versao: 2,
  aluno: { primeiro_nome: 'Claudia' },
  estado: { pausado_ate: null, encerrado: false },
  trilha: { principal: 'desafiador', secundaria: 'tecnico', adesao_ate_estabilizar: false, cadencia_dias: 14, cadencia_origem: 'trilha' },
  proxima_avaliacao: '2026-11-21',
  marcadores: {
    nome: 'Claudia', periodo: 'manhã', capacidade: 'hipertrofia', professor: 'Vanessa',
    frequencia: '5 vezes por semana', cadencia: '14', meta: '10 treinos', proxima_avaliacao: '21/11',
  },
  ...mudar,
});

const modelos = [
  { id: 'rotina:desafiador:a', situacao: 'rotina', trilha: 'desafiador', texto: '{nome}, faltam {dias_avaliacao} dias.', envio: 'sozinha' },
  { id: 'rotina:desafiador:b', situacao: 'rotina', trilha: 'desafiador', texto: '{nome}, desafio: treinar {frequencia}.', envio: 'sozinha' },
  { id: 'rotina:desafiador:c', situacao: 'rotina', trilha: 'desafiador', texto: '{nome}, marca {marca}.', envio: 'nao' },
  { id: 'rotina:adesao:a', situacao: 'rotina', trilha: 'adesao', texto: 'Oi, {nome}!', envio: 'sozinha' },
  { id: 'boas_vindas:todas:a', situacao: 'boas_vindas', trilha: 'todas', texto: 'Oi, {nome}! A cada {cadencia} dias.', envio: 'sozinha' },
  { id: 'reavaliacao:todas:a', situacao: 'reavaliacao', trilha: 'todas', texto: '{nome}, reavaliação em {proxima_avaliacao}.', envio: 'sozinha' },
  { id: 'ausencia:adesao:a', situacao: 'ausencia', trilha: 'adesao', texto: 'Sentimos sua falta, {nome}.', envio: 'sozinha' },
  { id: 'ausencia:todas:a', situacao: 'ausencia', trilha: 'todas', texto: 'Faz {dias} dias, {nome}.', envio: 'evo' },
];

const decidirEm = (hoje, historico, f = ficha(), modo = 'ensaio') => decidir({ ficha: f, modelos, historico, hoje, modo });

// ---- render ----

test('dias entre datas', () => {
  assert.equal(diasEntre('2026-10-08', '2026-11-21'), 44);
  assert.equal(diasEntre('2026-10-08', '2026-10-08'), 0);
  assert.equal(diasEntre('2026-10-08', '2026-10-01'), -7);
  assert.equal(diasEntre('2026-02-28', '2026-03-01'), 1);
});

test('preencher: tudo com valor', () => {
  assert.deepEqual(preencher('Oi, {nome}! {frequencia}.', { nome: 'Ana', frequencia: '3 vezes por semana' }),
    { texto: 'Oi, Ana! 3 vezes por semana.', faltam: [] });
});

test('preencher: marcador sem valor tira o texto inteiro, e diz qual', () => {
  assert.deepEqual(preencher('Oi, {nome}, faz {dias} dias, {dia}.', { nome: 'Ana', dias: null }),
    { texto: null, faltam: ['dias', 'dia'] });
  assert.deepEqual(preencher('{nome}', { nome: '  ' }), { texto: null, faltam: ['nome'] });
});

test('{dias_avaliacao} se conta no dia, e só de 2 para cima', () => {
  assert.equal(valoresDaFicha(ficha(), '2026-10-08').dias_avaliacao, '44');
  assert.equal(valoresDaFicha(ficha(), '2026-11-20').dias_avaliacao, null);
  assert.equal(valoresDaFicha(ficha(), '2026-11-22').dias_avaliacao, null);
  assert.equal(valoresDaFicha(ficha({ proxima_avaliacao: null }), '2026-10-08').dias_avaliacao, null);
});

// ---- situação ----

test('sem histórico: boas-vindas no ensaio, espera a ativação no envio', () => {
  assert.equal(situacaoDoDia({ ficha: ficha(), anteriores: [], hoje: '2026-10-08', modo: 'ensaio' }).situacao, 'boas_vindas');
  assert.equal(situacaoDoDia({ ficha: ficha(), anteriores: [], hoje: '2026-10-08', modo: 'envio' }).situacao, null);
});

test('rotina quando passa a cadência, contando de qualquer mensagem', () => {
  const h = [{ dia: '2026-10-08', situacao: 'boas_vindas', modelo_id: 'boas_vindas:todas:a' }];
  assert.equal(decidirEm('2026-10-21', h).status, 'nada');
  assert.match(decidirEm('2026-10-21', h).motivo, /Próxima rotina em 1 dia/);
  assert.equal(decidirEm('2026-10-22', h).situacao, 'rotina');
});

test('reavaliação 7 dias antes, uma vez por data, e zera o relógio da rotina', () => {
  const h = [{ dia: '2026-11-01', situacao: 'rotina', modelo_id: 'rotina:desafiador:a' }];
  assert.equal(decidirEm('2026-11-13', h).status, 'nada');           // 8 dias antes
  const d = decidirEm('2026-11-14', h);                               // 7 dias antes
  assert.equal(d.situacao, 'reavaliacao');
  assert.equal(d.texto, 'Claudia, reavaliação em 21/11.');
  const depois = [...h, { dia: '2026-11-14', situacao: 'reavaliacao', modelo_id: d.modelo_id }];
  assert.equal(decidirEm('2026-11-16', depois).status, 'nada');      // já avisou
  assert.match(decidirEm('2026-11-16', depois).motivo, /última em 14\/11/);
});

test('data da avaliação que já passou não dispara reavaliação', () => {
  const h = [{ dia: '2026-11-25', situacao: 'rotina', modelo_id: 'x' }];
  assert.notEqual(decidirEm('2026-11-26', h).situacao, 'reavaliacao');
});

test('pausa e encerramento calam a régua, com o motivo', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  const pausada = ficha({ estado: { pausado_ate: '2026-10-30', encerrado: false } });
  assert.deepEqual([decidirEm('2026-10-20', h, pausada).status, decidirEm('2026-10-20', h, pausada).motivo],
    ['nada', 'Pausado até 30/10.']);
  assert.equal(decidirEm('2026-10-31', h, pausada).situacao, 'rotina');
  assert.equal(decidirEm('2026-10-20', h, ficha({ estado: { encerrado: true } })).motivo, 'Acompanhamento encerrado no Prescrev.');
});

test('o mesmo dia rodado de novo não faz o relógio andar', () => {
  const h = [{ dia: '2026-10-08', situacao: 'boas_vindas', modelo_id: 'boas_vindas:todas:a' }];
  assert.equal(decidirEm('2026-10-08', h).situacao, 'boas_vindas');
});

// ---- modelo ----

test('candidatos: rotina só da trilha; situação da trilha antes de "todas"', () => {
  assert.deepEqual(candidatosDe(modelos, 'rotina', 'desafiador').map(m => m.id),
    ['rotina:desafiador:a', 'rotina:desafiador:b', 'rotina:desafiador:c']);
  assert.deepEqual(candidatosDe(modelos, 'ausencia', 'adesao').map(m => m.id), ['ausencia:adesao:a']);
  assert.deepEqual(candidatosDe(modelos, 'ausencia', 'tecnico').map(m => m.id), ['ausencia:todas:a']);
});

test('rodízio começa depois do último usado', () => {
  const c = candidatosDe(modelos, 'rotina', 'desafiador');
  assert.deepEqual(emRodizio(c, 'rotina:desafiador:a').map(m => m.id),
    ['rotina:desafiador:b', 'rotina:desafiador:c', 'rotina:desafiador:a']);
  assert.deepEqual(emRodizio(c, 'id-que-sumiu').map(m => m.id), c.map(m => m.id));
});

test('rotina alterna os modelos e pula o que não pode sair sozinho', () => {
  const h1 = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'rotina:desafiador:a' }];
  const d1 = decidirEm('2026-10-20', h1);
  assert.deepEqual([d1.status, d1.modelo_id, d1.texto],
    ['simulado', 'rotina:desafiador:b', 'Claudia, desafio: treinar 5 vezes por semana.']);
  // depois do b vem o c, que não sai sozinho ({marca}); volta ao a
  const h2 = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'rotina:desafiador:b' }];
  assert.equal(decidirEm('2026-10-20', h2).modelo_id, 'rotina:desafiador:a');
});

test('modelo com marcador sem valor passa ao seguinte; nenhum, bloqueia e diz o que falta', () => {
  const semFreq = ficha({ marcadores: { ...ficha().marcadores, frequencia: null }, proxima_avaliacao: null });
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  const d = decidirEm('2026-10-20', h, semFreq);
  assert.equal(d.status, 'bloqueado');
  assert.deepEqual(d.bloqueios, ['Nenhum modelo de rotina com todos os marcadores: falta {dias_avaliacao}, {frequencia}.']);
});

test('no envio a decisão fica pendente, e não simulada', () => {
  const h = [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }];
  assert.equal(decidirEm('2026-10-20', h, ficha(), 'envio').status, 'pendente');
});

test('trilha sem modelo da situação bloqueia com o motivo', () => {
  const d = decidir({ ficha: ficha({ trilha: { ...ficha().trilha, principal: 'tecnico' } }), modelos, historico: [{ dia: '2026-10-01', situacao: 'rotina', modelo_id: 'x' }], hoje: '2026-10-20', modo: 'ensaio' });
  assert.deepEqual([d.status, d.bloqueios], ['bloqueado', ['Nenhum modelo de rotina para a trilha tecnico.']]);
});

// ---- hora ----

const SEMANA = { inicioMin: 9 * 60, fimMin: 20 * 60 + 30 };
const SABADO = { inicioMin: 9 * 60, fimMin: 13 * 60 };
/** Minuto do dia em São Paulo de um Date. */
const minutoSP = (d) => ((d.getUTCHours() + 21) % 24) * 60 + d.getUTCMinutes();

test('hora prevista: começo do período, dentro da janela, espalhada por aluno', () => {
  const manha = horaPrevista(ficha(), '2026-10-08', SEMANA);
  assert.equal(manha.toISOString().slice(0, 10), '2026-10-08');
  assert.ok(minutoSP(manha) >= 9 * 60 && minutoSP(manha) <= 9 * 60 + 40, minutoSP(manha));
  const noite = horaPrevista(ficha({ marcadores: { ...ficha().marcadores, periodo: 'noite' } }), '2026-10-08', SEMANA);
  assert.ok(minutoSP(noite) >= 18 * 60 && minutoSP(noite) <= 18 * 60 + 40);
  // sábado a janela fecha às 13h: a noite não passa das 12h45
  const sabado = horaPrevista(ficha({ marcadores: { ...ficha().marcadores, periodo: 'noite' } }), '2026-10-10', SABADO);
  assert.ok(minutoSP(sabado) <= 12 * 60 + 45, minutoSP(sabado));
  // o mesmo aluno cai sempre no mesmo minuto
  assert.equal(horaPrevista(ficha(), '2026-10-08', SEMANA).getTime(), manha.getTime());
});

test('{proxima_avaliacao} perde o valor depois da data', () => {
  assert.equal(valoresDaFicha(ficha(), '2026-11-21').proxima_avaliacao, '21/11');
  assert.equal(valoresDaFicha(ficha(), '2026-11-22').proxima_avaliacao, null);
  // e o modelo que a usa sai da vez: o rodízio passa ao seguinte
  const h = [{ dia: '2026-11-10', situacao: 'rotina', modelo_id: 'rotina:desafiador:a' }];
  const ficha2 = ficha({ trilha: { ...ficha().trilha, cadencia_dias: 14 } });
  const so = [{ id: 'r:x', situacao: 'rotina', trilha: 'desafiador', texto: 'Reavaliação em {proxima_avaliacao}.', envio: 'sozinha' }];
  assert.equal(decidir({ ficha: ficha2, modelos: so, historico: h, hoje: '2026-11-28', modo: 'ensaio' }).status, 'bloqueado');
});
