/**
 * Testes das regras do retorno da coordenação sobre a aula experimental.
 *
 *   node --test src/services/retorno-aula-regras.test.js
 *
 * Puros: não chamam o modelo nem o banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  podeSerRetorno, aulasCandidatas, retornoDaAula, montarPedido, lerResposta, mesclarRetorno,
  presencaDoRetorno, resumoDoRetorno, textoParaConsultor, notaParaConsultor,
  confirmacaoParaCoordenacao, trechoParaFollowup,
} from './retorno-aula-regras.js';

const sp = (s) => new Date(`${s}-03:00`);
const AGORA = sp('2026-11-16T15:00:00');

const aula = (extra = {}) => ({
  leadId: 1268, nome: 'Luiza Souza', idade: 5, atividade: 'Natação Infantil', telefone: '5511993753764',
  experimental_at: '2026-11-16T13:00:00Z', experimental_status: 'agendada', stage: 'experimental_agendada',
  consultor: 'Shirlei Lima', ...extra,
});

// ── O filtro antes do modelo ─────────────────

test('o que nem vai ao modelo: cortesia, mídia sem texto, EQUIPE e o 1/2/3', () => {
  for (const m of ['ok', 'Obrigada!', '👍', '[imagem]', '[figurinha] gato', 'EQUIPE AB12CD', '2', '1 já falei com ele', '']) {
    assert.equal(podeSerRetorno(m), false, m);
  }
  assert.equal(podeSerRetorno('A Luiza veio e amou'), true);
  assert.equal(podeSerRetorno('[áudio] todos vieram hoje, a mãe da Luiza perguntou do plano'), true);
  assert.equal(podeSerRetorno('[áudio] ok'), false);
  assert.equal(podeSerRetorno('faltou'), true);
});

// ── De que aulas se pode estar falando ───────

test('candidatas: aula que já começou, até 7 dias atrás, fora a cancelada', () => {
  const lista = [
    aula({ leadId: 1 }),                                                          // hoje, 10h
    aula({ leadId: 2, experimental_at: '2026-11-16T22:00:00Z' }),                 // hoje, 19h: ainda não começou
    aula({ leadId: 3, experimental_at: '2026-11-08T13:00:00Z' }),                 // há 8 dias
    aula({ leadId: 4, experimental_at: '2026-11-14T14:00:00Z', experimental_status: 'cancelada' }),
    aula({ leadId: 5, experimental_at: '2026-11-14T14:00:00Z', stage: 'ganho' }), // já comprou: o retorno ainda vale
  ];
  assert.deepEqual(aulasCandidatas(lista, AGORA).map(a => a.leadId), [1, 5]);
});

test('retorno guardado só vale para a aula que o lead tem agora', () => {
  const r = { aula: '2026-11-16T13:00:00+00:00', presenca: 'veio' };
  assert.equal(retornoDaAula({ experimental_at: '2026-11-16T13:00:00Z', metadata: { retorno_aula: r } }), r);
  assert.equal(retornoDaAula({ experimental_at: '2026-11-20T13:00:00Z', metadata: { retorno_aula: r } }), null);   // remarcou
  assert.equal(retornoDaAula({ experimental_at: '2026-11-16T13:00:00Z', metadata: {} }), null);
});

// ── O pedido e a leitura da resposta ─────────

test('pedido ao modelo: as aulas com lead_id, a conversa, a citada e a mensagem', () => {
  const pedido = montarPedido({
    candidatas: [aula()],
    conversa: [{ de: 'leia', texto: 'Qual Luiza?' }],
    citada: '🙋 Como foi a aula experimental?\n*Luiza Souza*',
    mensagem: 'a da natação',
  });
  assert.match(pedido, /lead_id 1268: Luiza Souza, 5 anos — Natação Infantil — seg 16\/11, 10h00 — consultor: Shirlei Lima/);
  assert.match(pedido, /Sistema: Qual Luiza\?/);
  assert.match(pedido, /MENSAGEM CITADA NA RESPOSTA:/);
  assert.match(pedido, /MENSAGEM NOVA DA COORDENAÇÃO:\na da natação/);
});

test('resposta do modelo: tolera a cerca de código e recusa o que não se sustenta', () => {
  const candidatas = [aula(), aula({ leadId: 1300, nome: 'Guilherme' })];
  const saida = '```json\n' + JSON.stringify({
    eh_retorno: true,
    itens: [
      { lead_id: 1268, presenca: 'veio', satisfacao: '  amou a aula,\n a mãe perguntou do anual ', temperatura: 'quente', observacao: null },
      { lead_id: 9999, presenca: 'veio' },                          // não está na lista
      { lead_id: 1300, presenca: 'talvez', temperatura: 'pelando' }, // nada que se aproveite
      { lead_id: 1268, presenca: 'faltou' },                        // repetido
    ],
    duvida: null,
  }) + '\n```';
  const r = lerResposta(saida, candidatas);
  assert.equal(r.ehRetorno, true);
  assert.deepEqual(r.itens, [{
    leadId: 1268, presenca: 'veio', satisfacao: 'amou a aula, a mãe perguntou do anual', temperatura: 'quente', observacao: null,
  }]);
});

test('resposta do modelo: contar como foi implica presença; dúvida só sem item', () => {
  const candidatas = [aula()];
  const comSatisfacao = lerResposta('{"eh_retorno":true,"itens":[{"lead_id":1268,"presenca":null,"satisfacao":"gostou"}]}', candidatas);
  assert.equal(comSatisfacao.itens[0].presenca, 'veio');

  const duvida = lerResposta('{"eh_retorno":true,"itens":[],"duvida":"Qual Luiza: a da natação ou a do balé?"}', candidatas);
  assert.deepEqual(duvida, { ehRetorno: true, itens: [], duvida: 'Qual Luiza: a da natação ou a do balé?' });

  for (const lixo of ['', 'não entendi', '{"eh_retorno":false,"itens":[]}', '{quebrado', '{"eh_retorno":true,"itens":[]}']) {
    assert.equal(lerResposta(lixo, candidatas).ehRetorno, false, lixo);
  }
});

// ── Guardar ──────────────────────────────────

test('a segunda mensagem completa a primeira, e só novidade rearma o aviso', () => {
  const aulaEm = '2026-11-16T13:00:00Z';
  const um = mesclarRetorno(null, { presenca: 'veio', satisfacao: null, temperatura: null, observacao: null },
    { aula: aulaEm, por: '5511977770001', agora: AGORA });
  assert.equal(um.mudou, true);
  assert.equal(um.retorno.aviso_consultor, 'pendente');

  const enviado = { ...um.retorno, aviso_consultor: 'enviado', avisado_em: AGORA.toISOString(), avisado_para: 'Shirlei' };
  const repetida = mesclarRetorno(enviado, { presenca: 'veio' }, { aula: aulaEm, agora: AGORA });
  assert.equal(repetida.mudou, false);
  assert.equal(repetida.retorno.aviso_consultor, 'enviado');

  const dois = mesclarRetorno(enviado, { presenca: null, satisfacao: 'a mãe amou', temperatura: 'quente' }, { aula: aulaEm, agora: AGORA });
  assert.equal(dois.mudou, true);
  assert.deepEqual(
    [dois.retorno.presenca, dois.retorno.satisfacao, dois.retorno.temperatura, dois.retorno.aviso_consultor, dois.retorno.avisado_em],
    ['veio', 'a mãe amou', 'quente', 'pendente', undefined]);
  assert.equal(dois.retorno.por, '5511977770001');
});

test('retorno de aula antiga não se mistura com o da nova; corrigir para falta apaga a satisfação', () => {
  const velho = { aula: '2026-11-09T13:00:00Z', presenca: 'veio', satisfacao: 'gostou', temperatura: 'morna' };
  const novo = mesclarRetorno(velho, { presenca: 'faltou' }, { aula: '2026-11-16T13:00:00Z', agora: AGORA });
  assert.deepEqual([novo.retorno.presenca, novo.retorno.satisfacao, novo.retorno.temperatura], ['faltou', null, null]);

  const corrigido = mesclarRetorno(velho, { presenca: 'faltou' }, { aula: velho.aula, agora: AGORA });
  assert.equal(corrigido.mudou, true);
  assert.equal(corrigido.retorno.satisfacao, null);
});

test('presença do retorno no vocabulário da conversa pós-aula', () => {
  assert.equal(presencaDoRetorno({ presenca: 'veio' }), 'presente');
  assert.equal(presencaDoRetorno({ presenca: 'faltou' }), 'falta');
  assert.equal(presencaDoRetorno({ presenca: null, temperatura: 'morna' }), null);
  assert.equal(presencaDoRetorno(null), null);
});

// ── Textos ───────────────────────────────────

test('aviso ao consultor: temperatura no título, o que a coordenação contou e o empurrão pelo nome', () => {
  const quente = textoParaConsultor({
    aula: aula(), consultor: 'Shirlei Lima',
    retorno: { presenca: 'veio', satisfacao: 'amou a aula', temperatura: 'quente', observacao: 'a mãe perguntou do plano anual' },
  });
  assert.match(quente, /^🔥 \*Aula experimental — lead QUENTE\*/);
  assert.match(quente, /\*Luiza Souza\* \(5 anos\)\nNatação Infantil — seg 16\/11, 10h00/);
  assert.match(quente, /A coordenação contou: “amou a aula” — a mãe perguntou do plano anual/);
  assert.match(quente, /Contato: \(11\) 99375-3764/);
  assert.match(quente, /Shirlei, é agora: vai pra cima com a proposta fechada e garante essa matrícula hoje!/);

  assert.match(textoParaConsultor({ aula: aula(), consultor: 'Catia', retorno: { presenca: 'veio', temperatura: 'morna' } }),
    /lead MORNO[\s\S]*A coordenação confirmou a presença\.[\s\S]*Catia, falta pouco/);
  assert.match(textoParaConsultor({ aula: aula(), consultor: 'Catia', retorno: { presenca: 'veio', temperatura: 'fria' } }),
    /lead FRIO[\s\S]*ainda dá para virar/);
  assert.match(textoParaConsultor({ aula: aula(), consultor: 'Catia', retorno: { presenca: 'veio' } }),
    /^✅ \*Aula experimental — veio à aula\*[\s\S]*vai pra cima pra fechar essa matrícula/);
});

test('aviso ao consultor: quem faltou é para remarcar; sem dono, vai ao gerente dizendo isso', () => {
  const falta = textoParaConsultor({ aula: aula(), consultor: 'Shirlei', retorno: { presenca: 'faltou' } });
  assert.match(falta, /^🚫 \*Aula experimental — não veio\*/);
  assert.match(falta, /A coordenação confirmou a falta\./);
  assert.match(falta, /Shirlei, chama hoje mesmo para remarcar/);

  const semDono = textoParaConsultor({ aula: aula({ consultor: null }), retorno: { presenca: 'veio', temperatura: 'quente' } });
  assert.match(semDono, /Atendimento sem consultor responsável: quem pega\?/);
  assert.match(semDono, /\n\nÉ agora: vai pra cima/);

  const semNumero = textoParaConsultor({ aula: aula(), dono: 'Lucas', retorno: { presenca: 'veio', temperatura: 'quente' } });
  assert.match(semNumero, /O atendimento é de Lucas, que não tem WhatsApp cadastrado/);
});

test('nota do painel e resumo: uma linha, sem emoji de torcida', () => {
  const r = { presenca: 'veio', satisfacao: 'amou', temperatura: 'quente', observacao: 'prefere sábado' };
  assert.equal(resumoDoRetorno(r), 'veio à aula · "amou" · venda quente · obs.: prefere sábado');
  const nota = notaParaConsultor(r);
  assert.match(nota, /^Retorno da coordenação: veio à aula · "amou" · venda quente · obs\.: prefere sábado\. É agora: vai pra cima/);
  assert.ok(!nota.includes('💪'));
});

test('confirmação à coordenação: o que foi anotado e quem será avisado', () => {
  const texto = confirmacaoParaCoordenacao([
    { aula: aula(), retorno: { presenca: 'veio', satisfacao: 'amou', temperatura: 'quente' }, destino: 'Shirlei Lima' },
    { aula: aula({ nome: 'Guilherme' }), retorno: { presenca: 'faltou' }, destino: 'gerente' },
    { aula: aula({ nome: 'Emily' }), retorno: { presenca: 'veio' }, destino: null },
  ]);
  assert.equal(texto, [
    'Anotado ✅',
    '• *Luiza Souza*: veio à aula · "amou" · venda quente → aviso para Shirlei',
    '• *Guilherme*: não veio à aula → aviso ao gerente',
    '• *Emily*: veio à aula → fica no painel do consultor',
  ].join('\n'));
  assert.equal(confirmacaoParaCoordenacao([]), null);
});

test('conversa pós-aula: a Leia sabe a temperatura e não a repete ao cliente', () => {
  assert.equal(trechoParaFollowup(null), '');
  assert.equal(trechoParaFollowup({ observacao: 'prefere sábado' }), '');

  const quente = trechoParaFollowup({ presenca: 'veio', satisfacao: 'amou a aula', temperatura: 'quente' });
  assert.match(quente, /ela VEIO à aula; como saiu da aula: "amou a aula"; temperatura da venda: QUENTE/);
  assert.match(quente, /o que falta para ela começar/);
  assert.match(quente, /não mencione "temperatura"/);

  assert.match(trechoParaFollowup({ presenca: 'veio', temperatura: 'fria' }), /não finja entusiasmo/);
  const falta = trechoParaFollowup({ presenca: 'faltou' });
  assert.match(falta, /ela NÃO veio à aula/);
  assert.ok(!falta.includes('comemore'));
});
