/**
 * Testes do lembrete de aferir a PA no dia da sessão (Prescrev 070, 25/11/2026).
 *   node --test src/services/acompanhamento/pa.test.js
 * Puros: não leem `.env`, banco, EVO nem Prescrev. 26/11/2026 é quinta-feira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lembretesDePa, mesmoProfessor, sessaoDoLembrete, textoDoLembreteDePa } from './pa.js';

const URL = 'https://prescrev.exemplo';
const dia = '2026-11-26';
const sp = (hhmm) => new Date(`${dia}T${hhmm}:00-03:00`);
const TARDE = { 4: [['14:00', '22:00']] };
const MANHA = { 4: [['06:00', '12:00']] };
const ana = { profile_id: 'ana', phone: '5511900000001', nome: 'Ana', nome_completo: 'Ana Lima', horario: TARDE };
const bia = { profile_id: 'bia', phone: '5511900000002', nome: 'Bia', nome_completo: 'Beatriz Souza', horario: TARDE };
const protocolo = (id, extra = {}) => ({
  cliente_id: id, cliente_nome: `Aluno ${id}`, evo_id: 100, proxima: 1, caminho: `/dashboard/pa?cliente=${id}`, ...extra,
});
const sessao = (hora, instrutor = 'CARLOS MELO', extra = {}) => ({
  date: `${dia}T00:00:00`, startTime: hora, instructor: instrutor, name: 'NATAÇÃO ADULTO', statusID: 0, ...extra,
});
const rodar = (p) => lembretesDePa({ pessoas: [ana, bia], marca: null, dia, url: URL, total: 3, ...p });

test('o instrutor do EVO é a pessoa do Prescrev: primeiro nome, e o último quando há', () => {
  assert.equal(mesmoProfessor('ANA LIMA', 'Ana Lima'), true);
  assert.equal(mesmoProfessor('ANA ', 'Ana Lima'), true);
  assert.equal(mesmoProfessor('Ána Souza Lima', 'Ana Lima'), true);
  assert.equal(mesmoProfessor('ANA COSTA', 'Ana Lima'), false);
  assert.equal(mesmoProfessor('CARLOS', 'Ana Lima'), false);
  assert.equal(mesmoProfessor('', 'Ana Lima'), false);
});

test('a sessão do lembrete: a primeira ainda marcada, de 1 h antes a 30 min depois de começar', () => {
  const agora = sp('17:10');
  assert.equal(sessaoDoLembrete([sessao('18:00')], agora).instrutor, 'CARLOS MELO');
  assert.equal(sessaoDoLembrete([sessao('18:30')], agora), null, 'mais de 1 h antes: ainda não');
  assert.equal(sessaoDoLembrete([sessao('17:00')], agora).atividade, 'NATAÇÃO ADULTO');
  assert.equal(sessaoDoLembrete([sessao('18:00')], agora).comecou, false);
  assert.equal(sessaoDoLembrete([sessao('17:00')], agora).comecou, true);
  assert.equal(sessaoDoLembrete([sessao('16:45')], agora).comecou, true, 'começou há 25 min: ainda sai');
  assert.equal(sessaoDoLembrete([sessao('16:30')], agora), null, 'já passou');
  assert.equal(sessaoDoLembrete([sessao('18:00', 'X', { statusID: 1 })], agora), null, 'cancelada ou falta não conta');
  assert.equal(sessaoDoLembrete([], agora), null);
});

test('quem dá a aula é do Prescrev e está no turno: vai a ele, direto', () => {
  const r = rodar({ protocolos: [protocolo('c1')], sessoesDe: new Map([['c1', [sessao('18:00', 'BEATRIZ SOUZA')]]]), agora: sp('17:10') });
  assert.equal(r.envios.length, 1);
  assert.equal(r.envios[0].profile_id, 'bia');
  assert.equal(r.envios[0].direto, true);
  assert.match(r.envios[0].texto, /^Bia, Aluno c1 tem sessão às 18h \(NATAÇÃO ADULTO\) com você\. Afere a pressão antes de começar\./);
  assert.match(r.envios[0].texto, /É a 1ª de 3 aferições do protocolo de PA/);
  assert.match(r.envios[0].texto, /https:\/\/prescrev\.exemplo\/dashboard\/pa\?cliente=c1$/);
  assert.deepEqual(r.marca, { dia, avisados: { c1: 'bia' } });
});

test('quem dá a aula não é do Prescrev: vai a um professor no turno, que avisa', () => {
  const r = rodar({ protocolos: [protocolo('c1', { proxima: 2 })], sessoesDe: new Map([['c1', [sessao('18:00')]]]), agora: sp('17:10') });
  assert.equal(r.envios[0].profile_id, 'ana');
  assert.equal(r.envios[0].direto, false);
  assert.match(r.envios[0].texto, /^Ana, Aluno c1 tem sessão às 18h \(NATAÇÃO ADULTO\) com Carlos\. Avisa Carlos para aferir a pressão antes de começar\. É a 2ª de 3/);
});

test('sem o nome de quem dá a aula, o pedido é avisar quem dá a aula', () => {
  const t = textoDoLembreteDePa({
    quem: 'Ana', protocolo: protocolo('c1'), sessao: { em: sp('18:30'), instrutor: null, atividade: null }, direto: false, total: 3, url: URL,
  });
  assert.match(t, /^Ana, Aluno c1 tem sessão às 18h30\. Avisa quem dá a aula para aferir a pressão antes de começar\./);
});

test('agendou em cima da hora: sai no ciclo em que a sessão aparece, mesmo já começada', () => {
  const p = { protocolos: [protocolo('c1')], agora: sp('18:04') };
  // No ciclo anterior o EVO ainda não tinha a sessão: nada saiu, e a marca não andou.
  const antes = rodar({ ...p, agora: sp('17:59'), sessoesDe: new Map([['c1', []]]) });
  assert.equal(antes.envios.length, 0);
  const r = rodar({ ...p, marca: antes.marca, sessoesDe: new Map([['c1', [sessao('18:00')]]]) });
  assert.equal(r.envios.length, 1);
  assert.match(r.envios[0].texto, /^Ana, Aluno c1 está na sessão das 18h \(NATAÇÃO ADULTO\) com Carlos\. Avisa Carlos para aferir a pressão ainda nesta sessão\./);
  const direto = rodar({ ...p, sessoesDe: new Map([['c1', [sessao('18:00', 'ANA LIMA')]]]) });
  assert.match(direto.envios[0].texto, /com você\. Afere a pressão ainda nesta sessão\./);
});

test('os repasses se repartem: o segundo vai a quem recebeu menos hoje', () => {
  const r = rodar({
    protocolos: [protocolo('c1'), protocolo('c2')],
    sessoesDe: new Map([['c1', [sessao('18:00')]], ['c2', [sessao('18:00')]]]), agora: sp('17:10'),
  });
  assert.deepEqual(r.envios.map(e => e.profile_id), ['ana', 'bia']);
});

test('um lembrete por aluno e dia; no dia seguinte a marca recomeça', () => {
  const p = { protocolos: [protocolo('c1')], sessoesDe: new Map([['c1', [sessao('18:00')]]]), agora: sp('17:10') };
  assert.equal(rodar({ ...p, marca: { dia, avisados: { c1: 'ana' } } }).envios.length, 0);
  assert.equal(rodar({ ...p, marca: { dia: '2026-11-25', avisados: { c1: 'ana' } } }).envios.length, 1);
});

test('quem repassa precisa estar no turno na hora da sessão; sem ninguém, não sai e a marca não anda', () => {
  const cedo = { ...ana, horario: MANHA };
  const r = rodar({ pessoas: [cedo], protocolos: [protocolo('c1')], sessoesDe: new Map([['c1', [sessao('12:30')]]]), agora: sp('11:40') });
  assert.equal(r.envios.length, 0);
  assert.deepEqual(r.marca, { dia, avisados: {} });
});

test('sem sessão hoje, ou sem as sessões lidas, nada sai', () => {
  assert.equal(rodar({ protocolos: [protocolo('c1')], sessoesDe: new Map(), agora: sp('17:10') }).envios.length, 0);
  assert.equal(rodar({ protocolos: [protocolo('c1')], sessoesDe: new Map([['c1', []]]), agora: sp('17:10') }).envios.length, 0);
});
