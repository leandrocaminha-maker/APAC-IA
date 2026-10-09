/**
 * Testes das regras da ponte professor ↔ aluno (A5d). Puros, sem `.env`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AO_VIVO_MS, PRAZO_DA_PONTE_MS, cabecalhoAoProfessor, cabecalhoDeAudio, comandoSozinho, ehDoProfessor, idDaCitacao,
  legendaAoAluno, ponteVencida, quandoFicaSabendo, quandoRepassar, sentByProfessor, textoAoAluno, textoAoProfessor,
  textoDeEspera,
} from './ponte-regras.js';

test('a citação: no topo (Evolution v2) ou dentro do tipo da mensagem (WhatsApp)', () => {
  assert.equal(idDaCitacao({ contextInfo: { stanzaId: 'TOPO' }, message: { conversation: 'oi' } }), 'TOPO');
  assert.equal(idDaCitacao({ message: { extendedTextMessage: { text: 'oi', contextInfo: { stanzaId: 'TEXTO' } } } }), 'TEXTO');
  assert.equal(idDaCitacao({ message: { audioMessage: { seconds: 4, contextInfo: { stanzaId: 'AUDIO' } } } }), 'AUDIO');
  assert.equal(idDaCitacao({ message: { message: { imageMessage: { contextInfo: { stanzaId: 'DENTRO' } } } } }), 'DENTRO');
});

test('sem citação, nada: texto comum, contextInfo sem stanzaId, evento vazio', () => {
  assert.equal(idDaCitacao({ message: { conversation: 'oi' } }), null);
  assert.equal(idDaCitacao({ message: { extendedTextMessage: { text: 'oi', contextInfo: { mentionedJid: [] } } } }), null);
  assert.equal(idDaCitacao({}), null);
  assert.equal(idDaCitacao(undefined), null);
});

test('citando, só o número sozinho é comando — com texto, é mensagem ao aluno', () => {
  assert.deepEqual(['1', ' 2 ', '3.', '2!'].map(comandoSozinho), ['1', '2', '3', '2']);
  assert.deepEqual(['2 vezes por semana está ótimo', '1 vou ligar', '4', '12', 'ok', ''].map(comandoSozinho),
    [null, null, null, null, null, null]);
});

test('citando, a linha da opção copiada do briefing também é o comando', () => {
  assert.deepEqual([
    '1 - vou responder mais tarde ou pessoalmente', '1- Vou responder mais tarde ou pessoalmente.',
    '2 - está resolvido', '2 - esta resolvido', '3 - Não é comigo',
  ].map(comandoSozinho), ['1', '1', '2', '2', '3']);
  // Parte da linha, ou outra coisa depois do número, vai ao aluno.
  assert.deepEqual(['1 - vou responder mais tarde', '2 - está resolvido, qualquer coisa me chama'].map(comandoSozinho), [null, null]);
});

test('o remetente do professor não é humano nem bot', () => {
  const s = sentByProfessor('p-rafa');
  assert.equal(s, 'professor:p-rafa');
  assert.ok(ehDoProfessor(s));
  assert.ok(!s.startsWith('human') && !s.startsWith('bot'));
  assert.ok(!ehDoProfessor('human:x') && !ehDoProfessor(null));
});

test('ao aluno, assinado como o painel assina', () => {
  assert.equal(textoAoAluno('Rafael', 'Oi Claudia, tudo bem com o joelho?'), '*Rafael:*\nOi Claudia, tudo bem com o joelho?');
  assert.equal(cabecalhoDeAudio('Rafael'), '*Rafael:* 🎤');
  assert.equal(legendaAoAluno('Rafael', '[imagem]'), '*Rafael:*');
  assert.equal(legendaAoAluno('Rafael', 'faça assim'), '*Rafael:*\nfaça assim');
});

test('ao professor, os balões juntos, com o nome do aluno', () => {
  assert.equal(textoAoProfessor('Claudia', ['oi prof', 'melhorou sim']), '💬 *Claudia:*\noi prof\nmelhorou sim');
  assert.equal(cabecalhoAoProfessor('Claudia', 'audio', '[áudio] melhorou'), '💬 *Claudia:* 🎤');
  assert.equal(cabecalhoAoProfessor('Claudia', 'image', '[imagem]'), '💬 *Claudia*');
  assert.equal(cabecalhoAoProfessor('Claudia', 'image', 'olha o inchaço'), '💬 *Claudia:*\nolha o inchaço');
});

test('a ponte vence com 72 h sem mensagem nos dois sentidos', () => {
  const agora = new Date('2026-10-12T15:00:00Z');
  const ha = (ms) => new Date(agora.getTime() - ms).toISOString();
  assert.equal(ponteVencida({ ultima_em: ha(PRAZO_DA_PONTE_MS - 60_000) }, agora), false);
  assert.equal(ponteVencida({ ultima_em: ha(PRAZO_DA_PONTE_MS + 60_000) }, agora), true);
  assert.equal(ponteVencida({ ultima_em: ha(PRAZO_DA_PONTE_MS + 60_000), fechada_em: ha(1) }, agora), false);
});

// Segunda-feira 12/10/2026; horário de São Paulo é UTC-3.
const SEG = { 1: [['06:00', '10:00'], ['17:00', '21:00']], 2: [['06:00', '10:00']] };

test('no turno, a mensagem do aluno vai na hora', () => {
  const agora = new Date('2026-10-12T11:00:00Z'); // 08:00 em SP
  assert.deepEqual(quandoRepassar({ horario: SEG, ultimaDoProfessorEm: null, agora }), { acao: 'agora' });
});

test('fora do turno, espera o começo do próximo', () => {
  const agora = new Date('2026-10-12T15:00:00Z'); // 12:00 em SP, entre os turnos
  const q = quandoRepassar({ horario: SEG, ultimaDoProfessorEm: null, agora });
  assert.equal(q.acao, 'turno');
  assert.equal(q.enviarEm.toISOString(), '2026-10-12T20:00:00.000Z'); // 17:00 em SP
});

test('fora do turno, mas o professor escreveu há pouco: a conversa está acontecendo', () => {
  const agora = new Date('2026-10-13T02:00:00Z'); // 23:00 de segunda em SP
  const recente = new Date(agora.getTime() - AO_VIVO_MS + 60_000).toISOString();
  const velha = new Date(agora.getTime() - AO_VIVO_MS - 60_000).toISOString();
  assert.deepEqual(quandoRepassar({ horario: SEG, ultimaDoProfessorEm: recente, agora }), { acao: 'agora' });
  assert.equal(quandoRepassar({ horario: SEG, ultimaDoProfessorEm: velha, agora }).acao, 'turno');
});

test('sem horário cadastrado, não há para quando repassar', () => {
  assert.deepEqual(quandoRepassar({ horario: null, ultimaDoProfessorEm: null, agora: new Date() }), { acao: 'sem_horario' });
});

test('quando o professor fica sabendo — nunca quando responde', () => {
  assert.equal(quandoFicaSabendo({ estado: 'mais_tarde', as: '17:00' }), 'hoje às 17:00');
  assert.equal(quandoFicaSabendo({ estado: 'nao_hoje', volta: 'amanhã', as: '06:00' }), 'amanhã às 06:00');
  assert.equal(quandoFicaSabendo({ estado: 'nao_hoje', volta: 'segunda', as: '06:00' }), 'na segunda às 06:00');
  assert.equal(quandoFicaSabendo({ estado: 'nao_hoje', volta: 'sábado', as: '08:00' }), 'no sábado às 08:00');
  assert.equal(quandoFicaSabendo(null), 'assim que possível');
  assert.equal(textoDeEspera('Rafael', { estado: 'nao_hoje', volta: 'amanhã', as: '06:00' }),
    'Recebi e passei para Rafael, que vê a mensagem amanhã às 06:00 👍');
});
