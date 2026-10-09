/**
 * O que segura uma mensagem da régua na hora de sair (envio real, A5c).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motivoParaNaoSair } from './envio.js';

const ok = { inscricao: { status: 'ativa' }, suprimido: false, conversaHumana: false, escreveuEm24h: false, encaminhamentoAberto: false };

test('sai só quando tudo confere; cada trava diz por quê', () => {
  assert.equal(motivoParaNaoSair(ok), null);
  assert.match(motivoParaNaoSair({ ...ok, inscricao: null }), /não está ativo/);
  assert.match(motivoParaNaoSair({ ...ok, inscricao: { status: 'pausada' } }), /pausou ou saiu/);
  assert.match(motivoParaNaoSair({ ...ok, suprimido: true }), /suprimido/);
  assert.match(motivoParaNaoSair({ ...ok, encaminhamentoAberto: true }), /encaminhamento aberto/);
  assert.match(motivoParaNaoSair({ ...ok, conversaHumana: true }), /consultor/);
  assert.match(motivoParaNaoSair({ ...ok, escreveuEm24h: true }), /24 h/);
});
