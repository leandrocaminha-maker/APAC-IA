/**
 * O relatório em PDF no WhatsApp: o que sai, a quem, e com que frase (30/10/2026).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TENTATIVAS_MAX, legendaDoRelatorio, relatoriosParaEnviar } from './relatorios.js';

const ativa = { cliente_id: 'c1', phone: '5511999990000', status: 'ativa' };
const ativas = new Map([['c1', ativa]]);
const pub = (id, tipo, versao, cliente = 'c1') => ({ id, cliente_id: cliente, tipo, versao, primeiro_nome: 'Ana' });
const mensagens = {
  inicial: '{nome}, aqui está o seu relatório inicial em PDF, pra você consultar quando quiser.',
  completo: '{nome}, aqui está o seu relatório completo em PDF, com os resultados dos testes e as suas metas.',
  corrigido: '{nome}, aqui está a versão corrigida do seu relatório. Ela substitui a que você recebeu antes.',
};

test('só a inscrição ativa recebe: a pendente, a pausada e quem não ativou ficam de fora', () => {
  const publicados = [pub('r1', 'inicial', '2026-10-30T10:00:00Z'), pub('r2', 'inicial', '2026-10-30T10:00:00Z', 'c2')];
  const { enviar } = relatoriosParaEnviar(publicados, [], ativas);
  assert.deepEqual(enviar.map(e => e.relatorio.id), ['r1']);
  assert.equal(relatoriosParaEnviar(publicados, [], new Map()).enviar.length, 0);
});

test('cada versão sai uma vez; o Relatório 1 e o completo são relatórios diferentes', () => {
  const publicados = [pub('r1', 'inicial', '2026-10-20T10:00:00Z'), pub('r2', 'completo', '2026-10-30T10:00:00Z')];
  const ja = [{ relatorio_id: 'r1', cliente_id: 'c1', tipo: 'inicial', status: 'enviado' }];
  const { enviar } = relatoriosParaEnviar(publicados, ja, ativas);
  assert.deepEqual(enviar.map(e => [e.relatorio.id, e.corrigido]), [['r2', false]]);
});

test('reaberto e gerado de novo: só a versão mais nova sai, e como corrigida para quem recebeu a anterior', () => {
  const publicados = [pub('v1', 'completo', '2026-10-28T10:00:00Z'), pub('v2', 'completo', '2026-10-30T10:00:00Z')];
  const ja = [{ relatorio_id: 'v1', cliente_id: 'c1', tipo: 'completo', status: 'enviado' }];
  const r = relatoriosParaEnviar(publicados, ja, ativas);
  assert.deepEqual(r.enviar.map(e => [e.relatorio.id, e.corrigido]), [['v2', true]]);
  assert.equal(r.substituidos.length, 0, 'a que já saiu não vira substituída');
});

test('quem ativa depois da correção recebe só a versão nova, sem a frase de corrigida', () => {
  const publicados = [pub('v1', 'inicial', '2026-10-28T10:00:00Z'), pub('v2', 'inicial', '2026-10-30T10:00:00Z')];
  const r = relatoriosParaEnviar(publicados, [], ativas);
  assert.deepEqual(r.enviar.map(e => [e.relatorio.id, e.corrigido]), [['v2', false]]);
  assert.deepEqual(r.substituidos.map(s => s.id), ['v1']);
});

test('o envio que falhou tenta de novo, até o limite', () => {
  const publicados = [pub('r1', 'inicial', '2026-10-30T10:00:00Z')];
  const falhou = n => [{ relatorio_id: 'r1', cliente_id: 'c1', tipo: 'inicial', status: 'falhou', tentativas: n }];
  assert.deepEqual(relatoriosParaEnviar(publicados, falhou(1), ativas).enviar.map(e => e.tentativas), [1]);
  assert.equal(relatoriosParaEnviar(publicados, falhou(TENTATIVAS_MAX), ativas).enviar.length, 0);
});

test('a frase leva o primeiro nome; sem nome, começa pela frase', () => {
  const r = pub('r1', 'completo', '2026-10-30T10:00:00Z');
  assert.equal(legendaDoRelatorio(mensagens, r, false),
    'Ana, aqui está o seu relatório completo em PDF, com os resultados dos testes e as suas metas.');
  assert.match(legendaDoRelatorio(mensagens, r, true), /^Ana, aqui está a versão corrigida/);
  assert.equal(legendaDoRelatorio(mensagens, { ...r, primeiro_nome: '' }, false),
    'Aqui está o seu relatório completo em PDF, com os resultados dos testes e as suas metas.');
});
