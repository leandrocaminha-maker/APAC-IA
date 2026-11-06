/**
 * Testes da agenda de testes do dia ao professor (Prescrev 060, 05/11/2026).
 *   node --test src/services/acompanhamento/agenda-testes.test.js
 * Puros: não leem `.env`, banco nem Prescrev.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisosDaAgenda, desfazer } from './agenda-testes.js';

const URL = 'https://prescrev.exemplo';
const dia = '2026-11-05';
const agora = new Date('2026-11-05T09:00:00Z'); // 6h em São Paulo
const ana = { profile_id: 'ana', phone: '5511900000001', nome: 'Ana Lima' };
const m = (id, hora, extra = {}) => ({
  id, hora, inicio: new Date(`${dia}T${hora}:00-03:00`).toISOString(), duracao_min: 50,
  professor_id: 'ana', cliente_id: `c-${id}`, cliente_nome: `Aluno ${id}`, caminho: `/dashboard/clientes/c-${id}/testes`,
  cancelado_em: null, ...extra,
});

test('no começo do turno: a agenda do dia inteiro, com o link de cada aluno', () => {
  const r = avisosDaAgenda({ marcacoes: [m('2', '17:30'), m('1', '07:00')], marca: null, pessoas: [ana], dia, agora, url: URL });
  assert.equal(r.envios.length, 1);
  assert.match(r.envios[0].texto, /^Ana, sua agenda de testes de hoje:/);
  assert.ok(r.envios[0].texto.indexOf('7h · Aluno 1') < r.envios[0].texto.indexOf('17h30 · Aluno 2'));
  assert.match(r.envios[0].texto, /https:\/\/prescrev\.exemplo\/dashboard\/clientes\/c-1\/testes/);
  assert.deepEqual(r.marca, { dia, avisados: { 1: 'marcado', 2: 'marcado' }, comecou: { ana: true } });
});

test('sem teste no dia, nada sai, e o turno conta como começado', () => {
  const r = avisosDaAgenda({ marcacoes: [], marca: null, pessoas: [ana], dia, agora, url: URL });
  assert.equal(r.envios.length, 0);
  assert.equal(r.marca.comecou.ana, true);
});

test('depois do começo: só o que entrou e o que saiu', () => {
  const marca = { dia, avisados: { 1: 'marcado', 2: 'marcado' }, comecou: { ana: true } };
  const marcacoes = [m('1', '07:00'), m('2', '17:30', { cancelado_em: '2026-11-05T08:00:00Z' }), m('3', '18:00')];
  const r = avisosDaAgenda({ marcacoes, marca, pessoas: [ana], dia, agora, url: URL });
  assert.equal(r.envios.length, 1);
  assert.match(r.envios[0].texto, /^Ana, entrou um teste na sua agenda de hoje:/);
  assert.match(r.envios[0].texto, /18h · Aluno 3/);
  assert.match(r.envios[0].texto, /\n\nSaiu da sua agenda de hoje: 17h30 · Aluno 2\./);
  assert.doesNotMatch(r.envios[0].texto, /Aluno 1/);
  assert.equal(r.marca.avisados[2], 'cancelado');
  // Já avisado: nada sai de novo.
  assert.equal(avisosDaAgenda({ marcacoes, marca: r.marca, pessoas: [ana], dia, agora, url: URL }).envios.length, 0);
});

test('o teste que já começou não entra, e o cancelado nunca avisado não vira "saiu"', () => {
  const tarde = new Date('2026-11-05T20:40:00Z'); // 17h40
  const r = avisosDaAgenda({
    marcacoes: [m('1', '17:30'), m('2', '18:00', { cancelado_em: '2026-11-05T10:00:00Z' })],
    marca: null, pessoas: [ana], dia, agora: tarde, url: URL,
  });
  assert.equal(r.envios.length, 0);
});

test('a marca de ontem não vale hoje', () => {
  const r = avisosDaAgenda({
    marcacoes: [m('1', '07:00')], marca: { dia: '2026-11-04', avisados: { 1: 'marcado' }, comecou: { ana: true } },
    pessoas: [ana], dia, agora, url: URL,
  });
  assert.match(r.envios[0].texto, /sua agenda de testes de hoje/);
});

test('o envio que falhou volta atrás e sai no ciclo seguinte', () => {
  const r = avisosDaAgenda({ marcacoes: [m('1', '07:00')], marca: null, pessoas: [ana], dia, agora, url: URL });
  desfazer(r.marca, null, r.envios[0]);
  assert.deepEqual(r.marca, { dia, avisados: {}, comecou: {} });
  const de_novo = avisosDaAgenda({ marcacoes: [m('1', '07:00')], marca: r.marca, pessoas: [ana], dia, agora, url: URL });
  assert.match(de_novo.envios[0].texto, /sua agenda de testes de hoje/);
});

test('cada professor vê só a agenda dele', () => {
  const bia = { profile_id: 'bia', phone: '5511900000002', nome: 'Bia' };
  const r = avisosDaAgenda({ marcacoes: [m('1', '07:00')], marca: null, pessoas: [ana, bia], dia, agora, url: URL });
  assert.deepEqual(r.envios.map(e => e.profile_id), ['ana']);
});

import { lembretesDaVespera, textoDoLembrete } from './agenda-testes.js';
import { aplicadorDosTestes } from './encaminhamentos.js';
import { testesNoContexto } from './conversa.js';
import { CATEGORIAS } from './ferramentas.js';

const MODELO = '{nome}, amanhã às {hora} você faz os testes da sua avaliação com {professor}, na sala de musculação. ' +
  'Vem com roupa de treino. Se precisar mudar o horário, me conta por aqui.';
const amanha = '2026-11-06';
const doAluno = (id, extra = {}) => ({
  id, hora: '07:30', inicio: '2026-11-06T10:30:00.000Z', cliente_id: `c-${id}`, cliente_nome: 'maria souza',
  professor_id: 'ana', professor_nome: 'Ana Lima', cancelado_em: null, ...extra,
});

test('o lembrete da véspera: o primeiro nome, a hora curta e o professor sem artigo', () => {
  assert.equal(textoDoLembrete(MODELO, doAluno('1')),
    'Maria, amanhã às 7h30 você faz os testes da sua avaliação com Ana, na sala de musculação. ' +
    'Vem com roupa de treino. Se precisar mudar o horário, me conta por aqui.');
  assert.match(textoDoLembrete(MODELO, doAluno('1', { cliente_nome: '' })), /^Amanhã às 7h30/);
});

test('só a inscrição ativa recebe, uma vez por marcação, e a cancelada não', () => {
  const ativas = new Map([['c-1', { phone: '5511900000009' }], ['c-3', { phone: '5511900000010' }]]);
  const marcacoes = [doAluno('1'), doAluno('2'), doAluno('3', { cancelado_em: '2026-11-05T12:00:00Z' })];
  const r = lembretesDaVespera({ marcacoes, modelo: MODELO, marca: null, ativas, amanha });
  assert.deepEqual(r.sair.map(s => s.marcacao.id), ['1']);
  const depois = { ...r.marca, enviados: { 1: 'enviado' } };
  assert.equal(lembretesDaVespera({ marcacoes, modelo: MODELO, marca: depois, ativas, amanha }).sair.length, 0);
  // A marca de outro dia não vale.
  assert.equal(lembretesDaVespera({ marcacoes, modelo: MODELO, marca: { dia: '2026-11-05', enviados: { 1: 'enviado' } }, ativas, amanha }).sair.length, 1);
  // Sem a frase do Prescrev, nada sai.
  assert.equal(lembretesDaVespera({ marcacoes, modelo: null, marca: null, ativas, amanha }).sair.length, 0);
});

test('remarcar os testes vai a quem aplica, pelo nome da lista da equipe', () => {
  assert.ok(CATEGORIAS.includes('remarcar_testes'));
  const t = { professor_id: 'ana', professor_nome: 'Ana Lima' };
  assert.deepEqual(aplicadorDosTestes(t, [{ profile_id: 'ana', nome: 'Aninha' }]), { profile_id: 'ana', nome: 'Aninha', origem: 'aplicador_testes' });
  assert.equal(aplicadorDosTestes(t, []).nome, 'Ana');
});

test('a sessão de testes no contexto da Leia: some depois do dia', () => {
  const t = { dia: '2026-11-06', hora: '07:00', professor_nome: 'Ana Lima' };
  assert.equal(testesNoContexto(t, '2026-11-05'), 'sexta, 06/11, às 7h, com Ana');
  assert.equal(testesNoContexto(t, '2026-11-06'), 'sexta, 06/11, às 7h, com Ana');
  assert.equal(testesNoContexto(t, '2026-11-07'), null);
  assert.equal(testesNoContexto(null, '2026-11-05'), null);
});

import { avisosDaAvaliacao } from './agenda-testes.js';

const finalizado = (extra = {}) => ({
  chave: 'finalizado:av1|2026-11-05T20:40:00.000Z', cliente_id: 'c1', cliente_nome: 'Maria Souza',
  em: '2026-11-05T20:40:00.000Z', por_nome: 'Ana Lima', para_id: 'rafa', para_nome: 'Rafael Dias',
  caminho: '/dashboard/clientes/c1/fechamento', ...extra,
});
const relatorio = (extra = {}) => ({
  chave: 'relatorio:f1|2026-11-07T14:00:00.000Z', cliente_id: 'c1', cliente_nome: 'Maria Souza',
  em: '2026-11-07T14:00:00.000Z', avaliador_nome: 'Rafael Dias', para_id: 'bia', para_nome: 'Beatriz Costa',
  caminho: '/dashboard/clientes/c1/relatorio', ...extra,
});
const rafa = { profile_id: 'rafa', phone: '5511900000003', nome: 'Rafael Dias' };
const bia = { profile_id: 'bia', phone: '5511900000004', nome: 'Beatriz Costa' };
const naHora = new Date('2026-11-07T15:00:00Z');
const rodar = (extra) => avisosDaAvaliacao({ finalizados: [], relatorios: [], marca: null, pessoas: [rafa, bia], agora: naHora, url: URL, ...extra });

test('testes finalizados por outra pessoa: o avaliador recebe, com o link do fechamento', () => {
  const r = rodar({ finalizados: [finalizado()] });
  assert.deepEqual(r.envios.map(e => e.profile_id), ['rafa']);
  assert.equal(r.envios[0].texto,
    'Rafael, Ana finalizou os testes de Maria Souza em 05/11, às 17h40. Agora é com você: a conferência final e o ' +
    'ajuste do radar no relatório completo.\n\nhttps://prescrev.exemplo/dashboard/clientes/c1/fechamento');
});

test('relatório completo gerado: o profissional designado recebe, com o link do relatório', () => {
  const r = rodar({ relatorios: [relatorio()] });
  assert.deepEqual(r.envios.map(e => e.profile_id), ['bia']);
  assert.match(r.envios[0].texto, /^Beatriz, o relatório completo de Maria Souza está pronto\. Você é responsável pelo acompanhamento, por designação de Rafael/);
  assert.match(r.envios[0].texto, /https:\/\/prescrev\.exemplo\/dashboard\/clientes\/c1\/relatorio$/);
});

test('fora do turno ou sem EQUIPE, espera; já avisado, não repete; refeito, avisa de novo', () => {
  assert.equal(rodar({ finalizados: [finalizado()], pessoas: [] }).envios.length, 0);
  const marca = { avisados: { [finalizado().chave]: '2026-11-05T20:50:00.000Z' } };
  assert.equal(rodar({ finalizados: [finalizado()], marca }).envios.length, 0);
  assert.equal(rodar({ finalizados: [finalizado({ chave: 'finalizado:av1|2026-11-06T13:00:00.000Z' })], marca }).envios.length, 1);
});

test('a marca esquece o que saiu há mais de 7 dias', () => {
  const marca = { avisados: { velho: '2026-10-20T10:00:00.000Z', novo: '2026-11-04T10:00:00.000Z' } };
  assert.deepEqual(Object.keys(rodar({ marca }).marca.avisados), ['novo']);
});
