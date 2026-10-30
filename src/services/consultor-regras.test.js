/**
 * Testes da vez do consultor.
 *
 *   node --test src/services/consultor-regras.test.js
 *
 * Puros. Os casos vêm das conversas em que a Leia respondeu por cima de um
 * consultor, até 30/10/2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quemResponde, ehDespedida, ehDoConsultor, emailDoConsultor, terminaEmPergunta,
} from './consultor-regras.js';

const sp = (s) => new Date(`${s}-03:00`);
const JANELA = 6;

const shirlei = (content, em) => ({ sent_by: 'human:shirlei@apacademia.com.br', content, created_at: sp(em).toISOString() });

test('Tais, 30/10: "Obrigada" um minuto depois da Shirlei — a Leia não responde', () => {
  const ultimaNossa = shirlei('*Shirlei:*\nAvisei as professoras', '2026-10-30T09:56:21');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Obrigada', janelaHoras: JANELA, agora: sp('2026-10-30T09:57:41') }), 'ninguem');
});

test('Tais, 09/10: o "🙏🏽" uma hora e meia depois de "Aula agendada" também não', () => {
  const ultimaNossa = shirlei('*Shirlei:*\nBOm dia \nAula agendada', '2026-10-09T06:20:18');
  assert.equal(quemResponde({ ultimaNossa, conteudo: '🙏🏽', janelaHoras: JANELA, agora: sp('2026-10-09T07:58:09') }), 'ninguem');
});

test('pedido depois do consultor volta para ele', () => {
  const ultimaNossa = { sent_by: 'human:whatsapp', content: 'Agendado', created_at: sp('2026-09-29T11:08:00').toISOString() };
  const agora = sp('2026-09-29T11:10:00');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Ok', janelaHoras: JANELA, agora }), 'ninguem');
  assert.equal(quemResponde({ ultimaNossa, conteudo: '9h15', janelaHoras: JANELA, agora }), 'consultor');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Qual o valor do plano normal?', janelaHoras: JANELA, agora }), 'consultor');
  assert.equal(quemResponde({ ultimaNossa, conteudo: '[imagem]', janelaHoras: JANELA, agora }), 'consultor');   // o comprovante é para ele
});

test('depois de pergunta do consultor, até "sim" é resposta para ele', () => {
  const ultimaNossa = shirlei('*Shirlei:*\nPosso marcar às 9h? 😊', '2026-09-21T10:20:00');
  const agora = sp('2026-09-21T10:22:00');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Sim', janelaHoras: JANELA, agora }), 'consultor');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Obrigada', janelaHoras: JANELA, agora }), 'consultor');
});

test('passada a janela, a Leia responde: é assunto novo', () => {
  const ultimaNossa = shirlei('*Shirlei:*\nAgendada', '2026-10-16T07:17:52');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Marcar aula', janelaHoras: JANELA, agora: sp('2026-10-30T09:38:48') }), 'leia');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Marcar aula', janelaHoras: JANELA, agora: sp('2026-10-16T13:17:53') }), 'leia');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Marcar aula', janelaHoras: JANELA, agora: sp('2026-10-16T13:17:51') }), 'consultor');
});

test('última fala nossa da Leia, da régua ou da ponte: segue a Leia', () => {
  const agora = sp('2026-10-30T10:00:00');
  for (const sent_by of ['bot', 'bot:followup', 'bot:ponte', 'bot:acompanhamento:leia', 'bot:gerencia']) {
    const ultimaNossa = { sent_by, content: 'Oi', created_at: sp('2026-10-30T09:59:00').toISOString() };
    assert.equal(quemResponde({ ultimaNossa, conteudo: 'Quanto custa?', janelaHoras: JANELA, agora }), 'leia', sent_by);
  }
  assert.equal(quemResponde({ ultimaNossa: null, conteudo: 'Oi', janelaHoras: JANELA, agora }), 'leia');
});

test('janela 0 desliga a regra', () => {
  const ultimaNossa = shirlei('Agendada', '2026-10-30T09:56:00');
  assert.equal(quemResponde({ ultimaNossa, conteudo: 'Obrigada', janelaHoras: 0, agora: sp('2026-10-30T09:57:00') }), 'leia');
});

test('despedida: cortesia e agradecimento curto', () => {
  for (const t of [
    'Obrigada', 'Ok obrigada', 'Obrigada Shirlei!', 'Obrigada Cátia', 'Ok obg', 'Ok, muito obrigado',
    'Fechado obrigada', 'Fechou, obrigada!!', 'Isso! Obrigada', 'Obrigadaaaa', 'Obrigado  Deus abençoe',
    'obg, igualmente', 'Ótimo, obrigada pelo retorno.', 'Está bem muito obgda Cátia',
    'Oi Shirlei Bom dia  Obrigada! Ótimo dia', 'Grata', '🙏🏽', '👍🏻', '[mensagem não suportada]',
  ]) {
    assert.equal(ehDespedida(t), true, t);
  }
});

test('não é despedida: pergunta, pedido, "mas", relato longo, mídia', () => {
  for (const t of [
    '9h15', 'Pode marcar as 9:00 ?', 'Obrigada, mas não consegui agendar', 'Obrigada! E amanhã tem aula?',
    'Muito obrigado moça, e que por conta dessas chuvas, tivemos um imprevisto que nos impediu de ir',
    'Já reinstalei o aplicativo, e mesmo assim a mensagem continua', '[imagem]', '[documento]',
  ]) {
    assert.equal(ehDespedida(t), false, t);
  }
});

test('autoria e pergunta', () => {
  assert.equal(ehDoConsultor('human:whatsapp'), true);
  assert.equal(ehDoConsultor('human:catia@apacademia.com.br'), true);
  assert.equal(ehDoConsultor('bot'), false);
  assert.equal(emailDoConsultor('human:catia@apacademia.com.br'), 'catia@apacademia.com.br');
  assert.equal(emailDoConsultor('human:whatsapp'), null);
  assert.equal(terminaEmPergunta('*Catia:*\nBoa noite !\nQual o nome dela completo pfv?'), true);
  assert.equal(terminaEmPergunta('Tudo bem? Agendada 😉'), false);
});
