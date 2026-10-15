/**
 * Testes das regras da pesquisa pelo número alternativo.
 *
 *   node --test src/services/pesquisa-regras.test.js
 *
 * Puros: não leem `.env` nem banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABERTURA_PADRAO, DICA_DO_LINK, ETAPA, LINK_PADRAO, TETO_MAXIMO,
  decidirResposta, diasDeUso, ehOrigemDeLink, ehPesquisa, escolherVariante, formasDoTelefone,
  lerMensagemRecebida, lerResposta, linkDoNumero, nomeDeTratamento, origemAbertura, origemLink, preencher,
  problemasDosModelos, tempoDeResposta, tetoDoDia, textoDeAbertura, textoDoLink, textoFixo, variantes, TEXTOS,
} from './pesquisa-regras.js';

const NUMERO = '11 94071-5006';
const campanha = { slug: 'satisfacao', finalidade: 'pesquisa', link: 'https://exemplo.com/p' };

// ── Teto e rampa ────────────────────────────────────────────────────────

test('a rampa vale nos primeiros dias, e depois o teto cheio', () => {
  const regra = { tetoDiario: 80, rampa: [25, 40, 60] };
  assert.deepEqual([0, 1, 2, 3, 10].map(d => tetoDoDia(d, regra)), [25, 40, 60, 80, 80]);
});

test('o degrau da rampa nunca passa do teto, e o teto nunca passa do corte', () => {
  assert.equal(tetoDoDia(0, { tetoDiario: 20, rampa: [25, 40] }), 20);
  assert.equal(tetoDoDia(5, { tetoDiario: 500, rampa: [] }), TETO_MAXIMO);
  assert.equal(tetoDoDia(0, { tetoDiario: 500, rampa: [300] }), TETO_MAXIMO);
  assert.equal(tetoDoDia(0, { tetoDiario: -3, rampa: [] }), 0);
});

test('o dia de uso vira à meia-noite de São Paulo, não à do servidor', () => {
  const primeira = '2026-10-13T12:00:00Z';                       // 13/10, 9h em SP
  assert.equal(diasDeUso(null, new Date('2026-10-13T12:00:00Z')), 0);
  assert.equal(diasDeUso(primeira, new Date('2026-10-14T02:30:00Z')), 0);   // 13/10, 23h30 em SP
  assert.equal(diasDeUso(primeira, new Date('2026-10-14T03:30:00Z')), 1);   // 14/10, 0h30 em SP
  assert.equal(diasDeUso(primeira, new Date('2026-10-16T15:00:00Z')), 3);
});

// ── Textos ──────────────────────────────────────────────────────────────

test('"---" sozinho na linha separa as redações, com LF ou CRLF', () => {
  assert.deepEqual(variantes('um\n---\ndois\r\n ---  \r\ntrês'), ['um', 'dois', 'três']);
  assert.deepEqual(variantes('uma só — com travessão --- no meio'), ['uma só — com travessão --- no meio']);
  assert.deepEqual(variantes(null), []);
});

test('cada alvo recebe sempre a mesma redação, e a lista se divide por igual', () => {
  const modelo = 'a\n---\nb\n---\nc';
  assert.equal(escolherVariante(modelo, 7), escolherVariante(modelo, 7));
  assert.deepEqual([0, 1, 2, 3].map(id => escolherVariante(modelo, id)), ['a', 'b', 'c', 'a']);
  assert.equal(escolherVariante('', 3), '');
});

test('o nome do cadastro vira nome de gente, ou nada', () => {
  assert.equal(nomeDeTratamento('MARIA APARECIDA'), 'Maria');
  assert.equal(nomeDeTratamento('  joão  '), 'João');
  assert.equal(nomeDeTratamento('ÂNGELA'), 'Ângela');
  for (const lixo of ['', null, '.', 'A', 'Teste2 Silva', '11999999999']) {
    assert.equal(nomeDeTratamento(lixo), null);
  }
});

test('sem nome, o marcador sai com a vírgula dele — e a frase segue de pé', () => {
  assert.equal(preencher('Oi, {nome}! Aqui é a AP.', { nome: 'Ana' }), 'Oi, Ana! Aqui é a AP.');
  assert.equal(preencher('Oi, {nome}! Aqui é a AP.'), 'Oi! Aqui é a AP.');
  assert.equal(preencher('{nome}, oi! Aqui é a AP.'), 'Oi! Aqui é a AP.');
  assert.equal(preencher('{nome}, este é o link:\n{link}', { link: 'https://x.y' }), 'Este é o link:\nhttps://x.y');
});

test('as três aberturas padrão: nome, número de atendimento, uma pergunta, SAIR — e nenhum link', () => {
  for (const id of [0, 1, 2]) {
    const texto = textoDeAbertura({ id, nome: 'CLAUDIA' }, campanha, { numeroPrincipal: NUMERO });
    assert.match(texto, /Claudia/);
    assert.match(texto, /Aqui é da direção da AP Academia/);
    assert.match(texto, /Posso te enviar o link\?/);
    assert.ok(texto.includes(NUMERO));
    assert.match(texto, /\bSAIR\b/);
    assert.equal(texto.match(/\?/g).length, 1);
    assert.doesNotMatch(texto, /https?:|\{/);
  }

  const semNome = textoDeAbertura({ id: 2, nome: null }, campanha, { numeroPrincipal: NUMERO });
  assert.match(semNome, /^Oi! Aqui é da direção da AP Academia\./);
});

test('a abertura da campanha vale no lugar da padrão', () => {
  const propria = { ...campanha, mensagem_abertura: 'Olá, {nome}. Posso mandar? SAIR para parar.' };
  assert.equal(textoDeAbertura({ id: 1, nome: 'rui' }, propria), 'Olá, Rui. Posso mandar? SAIR para parar.');
});

test('o link só leva a dica de "não abre" quando sai sem resposta', () => {
  const alvo = { id: 1, nome: 'Rui' };
  const pedido = textoDoLink(alvo, campanha, { numeroPrincipal: NUMERO });
  assert.ok(pedido.includes(campanha.link));
  assert.ok(!pedido.includes(DICA_DO_LINK));

  const porPrazo = textoDoLink(alvo, campanha, { numeroPrincipal: NUMERO, semResposta: true });
  assert.ok(porPrazo.includes(campanha.link) && porPrazo.endsWith(DICA_DO_LINK));
});

test('campanha sem link não produz mensagem de link', () => {
  assert.equal(textoDoLink({ id: 1 }, { ...campanha, link: null }), '');
});

test('as respostas fixas trazem o número de atendimento e o endereço dele, sozinho no fim da linha', () => {
  for (const qual of ['esclarecimento', 'encerramento', 'aviso']) {
    const texto = textoFixo(qual, { numeroPrincipal: NUMERO });
    assert.ok(texto.includes(NUMERO), qual);
    assert.match(texto, /^https:\/\/wa\.me\/5511940715006$/m, qual);
    assert.doesNotMatch(texto, /\{/, qual);
  }
});

test('a resposta de saída não promete mais que este número, e não leva endereço', () => {
  assert.match(textoFixo('saida'), /por este número/);
  assert.doesNotMatch(textoFixo('saida', { numeroPrincipal: NUMERO }), /wa\.me/);
});

test('o endereço do número: com DDI, sem DDI e sem número', () => {
  assert.equal(linkDoNumero('11 94071-5006'), 'https://wa.me/5511940715006');
  assert.equal(linkDoNumero('(11) 3904-1234'), 'https://wa.me/551139041234');
  assert.equal(linkDoNumero('+55 11 94071-5006'), 'https://wa.me/5511940715006');
  assert.equal(linkDoNumero(''), '');
});

test('a abertura não aceita o endereço do número de atendimento, nem pelo marcador', () => {
  for (const abertura of [
    'Oi, {nome}. Somos nós: {link_principal} Posso te enviar o link? SAIR para parar.',
    'Oi, {nome}. Somos nós: wa.me/5511940715006 Posso te enviar o link? SAIR para parar.',
  ]) {
    assert.match(problemasDosModelos({ link: campanha.link, mensagem_abertura: abertura }).join('\n'), /tem link/);
  }
});

test('os textos padrão passam na própria conferência', () => {
  assert.deepEqual(problemasDosModelos({ link: campanha.link }), []);
  assert.deepEqual(
    problemasDosModelos({ link: campanha.link, mensagem_abertura: ABERTURA_PADRAO, mensagem_link: LINK_PADRAO }),
    [],
  );
});

test('a conferência recusa link na abertura, abertura sem SAIR ou sem pergunta, e link sem marcador', () => {
  const problemas = problemasDosModelos({
    link: 'http://sem-tls.com/p',
    mensagem_abertura: 'Oi! Responda aqui: https://x.y/p',
    mensagem_link: 'Segue o endereço.',
  });
  assert.equal(problemas.length, 5);
  assert.match(problemas.join('\n'), /https:\/\//);
  assert.match(problemas.join('\n'), /tem link/);
  assert.match(problemas.join('\n'), /SAIR/);
  assert.match(problemas.join('\n'), /UMA pergunta/);
  assert.match(problemas.join('\n'), /\{link\}/);
});

// ── Origem e finalidade ─────────────────────────────────────────────────

test('as duas origens da fila começam com alt:, e só uma é link', () => {
  assert.equal(origemAbertura('sat'), 'alt:campanha:sat');
  assert.equal(origemLink('sat'), 'alt:link:sat');
  assert.ok(ehOrigemDeLink(origemLink('sat')) && !ehOrigemDeLink(origemAbertura('sat')));
  assert.ok(!ehOrigemDeLink('campanha:sat') && !ehOrigemDeLink(null));
});

test('campanha sem finalidade é de venda — é o que a migration por aplicar devolve', () => {
  assert.ok(ehPesquisa({ finalidade: 'pesquisa' }));
  assert.ok(!ehPesquisa({ finalidade: 'venda' }) && !ehPesquisa({}) && !ehPesquisa(null));
});

// ── O que chegou ────────────────────────────────────────────────────────

const evento = (key, message) => ({ event: 'messages.upsert', instance: 'alt', data: { key, message } });
const DE = { remoteJid: '5511987654321@s.whatsapp.net', fromMe: false, id: 'ABC' };

test('lê texto, texto longo e reação — a reação é resposta', () => {
  assert.deepEqual(lerMensagemRecebida(evento(DE, { conversation: 'Pode mandar' })),
    { phone: '5511987654321', fromMe: false, id: 'ABC', content: 'Pode mandar' });
  assert.equal(lerMensagemRecebida(evento(DE, { extendedTextMessage: { text: 'sim' } })).content, 'sim');
  assert.equal(lerMensagemRecebida(evento(DE, { reactionMessage: { text: '👍' } })).content, '👍');
  assert.equal(lerMensagemRecebida(evento(DE, { audioMessage: {} })).content, '[áudio]');
});

test('grupo, status, reação retirada e evento de protocolo não são mensagem', () => {
  assert.equal(lerMensagemRecebida(evento({ ...DE, remoteJid: '123@g.us' }, { conversation: 'oi' })), null);
  assert.equal(lerMensagemRecebida(evento({ ...DE, remoteJid: 'status@broadcast' }, { conversation: 'oi' })), null);
  assert.equal(lerMensagemRecebida(evento(DE, { reactionMessage: { text: '' } })), null);
  assert.equal(lerMensagemRecebida(evento(DE, { protocolMessage: { type: 0 } })), null);
  assert.equal(lerMensagemRecebida({}), null);
});

test('conta com LID: o número vem de senderPn, ou não vem', () => {
  const lid = { remoteJid: '99887766@lid', fromMe: false, id: 'X' };
  assert.equal(lerMensagemRecebida(evento({ ...lid, senderPn: '5511987654321@s.whatsapp.net' }, { conversation: 'oi' })).phone,
    '5511987654321');
  assert.equal(lerMensagemRecebida(evento(lid, { conversation: 'oi' })).phone, null);
});

test('o eco do que saiu vem marcado como nosso', () => {
  assert.equal(lerMensagemRecebida(evento({ ...DE, fromMe: true }, { conversation: 'oi' })).fromMe, true);
});

test('o mesmo celular com e sem o nono dígito', () => {
  assert.deepEqual(formasDoTelefone('5531987654321'), ['5531987654321', '553187654321']);
  assert.deepEqual(formasDoTelefone('553187654321'), ['553187654321', '5531987654321']);
  assert.deepEqual(formasDoTelefone('14155550100'), ['14155550100']);
  assert.deepEqual(formasDoTelefone(''), []);
});

// ── A leitura da resposta ───────────────────────────────────────────────

test('sim: no começo, no meio da frase, e por emoji', () => {
  for (const t of ['Sim', 'pode', 'Pode sim!', 'Bom dia! Pode mandar', 'oi, claro', 'manda aí', 'ok obrigado',
    's', 'Quero', 'por favor', '👍', '👍🏽', '🙏🙏', 'blz']) {
    assert.equal(lerResposta(t), 'sim', t);
  }
});

test('não: recusa curta e clara', () => {
  for (const t of ['Não', 'nao', 'Não, obrigado', 'não quero', 'agora não', 'sem interesse', 'N', 'Não precisa']) {
    assert.equal(lerResposta(t), 'nao', t);
  }
});

test('pergunta, desconfiança e conversa nunca viram sim', () => {
  for (const t of ['Quem é?', 'isso é golpe', 'pode ser golpe né', 'Que pesquisa é essa?', 'não sei', 'não entendi',
    'não abriu', 'bom dia', 'oi', '', '[áudio]', 'sim, mas é rápido?', 'como funciona',
    'pode mandar sim, mas antes eu queria falar da piscina que está fria faz três semanas e ninguém resolve']) {
    assert.equal(lerResposta(t), 'outro', t);
  }
});

// ── O que fazer com a resposta ──────────────────────────────────────────

const decide = (etapa, resposta, pedidoDeSaida = false) => decidirResposta({ etapa, resposta, pedidoDeSaida });

test('esperando a resposta: sim manda o link, não agradece, o resto esclarece uma vez', () => {
  assert.deepEqual(decide(ETAPA.aguardando, 'sim'), { acao: 'link', etapa: ETAPA.link });
  assert.deepEqual(decide(ETAPA.aguardando, 'nao'), { acao: 'recusar', etapa: ETAPA.recusou });
  assert.deepEqual(decide(ETAPA.aguardando, 'outro'), { acao: 'esclarecer', etapa: ETAPA.esclarecida });

  assert.deepEqual(decide(ETAPA.esclarecida, 'sim'), { acao: 'link', etapa: ETAPA.link });
  assert.equal(decide(ETAPA.esclarecida, 'outro').acao, 'silencio');
});

test('depois do link: um agradecimento, e depois silêncio', () => {
  assert.deepEqual(decide(ETAPA.link, 'outro'), { acao: 'encerrar', etapa: ETAPA.encerrada });
  assert.deepEqual(decide(ETAPA.link, 'sim'), { acao: 'encerrar', etapa: ETAPA.encerrada });
  assert.equal(decide(ETAPA.link, 'nao').acao, 'recusar');
  for (const fim of [ETAPA.encerrada, ETAPA.recusou]) {
    assert.equal(decide(fim, 'sim').acao, 'silencio');
  }
});

test('SAIR vale em qualquer ponto, inclusive de quem não é alvo — e quem saiu não ouve mais nada', () => {
  for (const etapa of [null, ETAPA.aguardando, ETAPA.esclarecida, ETAPA.link, ETAPA.encerrada, ETAPA.recusou]) {
    assert.deepEqual(decide(etapa, 'outro', true), { acao: 'sair', etapa: ETAPA.saiu });
  }
  assert.equal(decide(ETAPA.saiu, 'sim').acao, 'silencio');
  assert.equal(decide(ETAPA.saiu, 'outro', true).acao, 'silencio');
});

test('quem escreve sem ser alvo recebe o aviso, nunca o link', () => {
  assert.deepEqual(decide(null, 'sim'), { acao: 'aviso', etapa: null });
  assert.deepEqual(decide('aguardando_consentimento', 'sim'), { acao: 'aviso', etapa: null });
});

test('resposta: o total sorteado fica entre 10 e 20 s, com o digitando dentro dele', () => {
  const p = { minSeg: 10, maxSeg: 20 };
  assert.deepEqual(tempoDeResposta({ ...p, digitacaoMs: 4_000, sorteio: 0 }), { pausaMs: 6_000, digitandoMs: 4_000 });
  assert.deepEqual(tempoDeResposta({ ...p, digitacaoMs: 4_000, sorteio: 1 }), { pausaMs: 16_000, digitandoMs: 4_000 });
  // Texto comprido: o digitando é cortado no total, e não há pausa calada.
  assert.deepEqual(tempoDeResposta({ ...p, digitacaoMs: 15_000, sorteio: 0 }), { pausaMs: 0, digitandoMs: 10_000 });

  for (let i = 0; i < 200; i++) {
    const { pausaMs, digitandoMs } = tempoDeResposta({ ...p, digitacaoMs: 9_000 });
    const total = pausaMs + digitandoMs;
    assert.ok(total >= 10_000 && total <= 20_000, String(total));
    assert.ok(pausaMs >= 0 && digitandoMs <= 9_000);
  }
});

test('o texto do link e o agradecimento não repetem "a gente"', () => {
  const vezes = (t) => (t.match(/a gente/gi) ?? []).length;
  for (const texto of [LINK_PADRAO, TEXTOS.encerramento, ...variantes(ABERTURA_PADRAO)]) {
    for (const paragrafo of texto.split('\n\n')) assert.ok(vezes(paragrafo) <= 1, paragrafo);
  }
});
