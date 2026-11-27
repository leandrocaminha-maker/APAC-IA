/**
 * O ensaio da API oficial contra uma Meta de mentira: o corpo que sai, o
 * erro que volta, a assinatura do aviso e a rota inteira.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import express from 'express';

const SEGREDO = 'segredo-do-app';
const pedidos = [];
let meta;        // a Graph API de mentira
let backend;     // um express só com a rota
let oficial;
let regras;
let urlBackend;

const escutar = (servidor) => new Promise(ok => servidor.listen(0, '127.0.0.1', () => ok(servidor.address().port)));

before(async () => {
  meta = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', p => { corpo += p; });
    req.on('end', () => {
      const json = corpo ? JSON.parse(corpo) : null;
      pedidos.push({ method: req.method, url: req.url, auth: req.headers.authorization, json });
      res.setHeader('Content-Type', 'application/json');
      if (json?.type === 'text' && json.to === '5511900000000') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message', error_data: { details: 'mais de 24 h' } } }));
      }
      if (req.method === 'POST') {
        return res.end(JSON.stringify({ contacts: [{ input: json.to, wa_id: '551182592538' }], messages: [{ id: 'wamid.TESTE' }] }));
      }
      res.end(JSON.stringify({ display_phone_number: '+1 555 000 0000', quality_rating: 'GREEN' }));
    });
  });
  const portaMeta = await escutar(meta);

  // O `config.js` lê o ambiente na importação: as variáveis vêm antes.
  process.env.WA_OFICIAL_TOKEN = 'token-de-teste';
  process.env.WA_OFICIAL_PHONE_ID = '111222333';
  process.env.WA_OFICIAL_GRAPH_URL = `http://127.0.0.1:${portaMeta}`;
  process.env.WA_OFICIAL_GRAPH_VERSAO = 'v99.0';
  process.env.WA_OFICIAL_VERIFY_TOKEN = 'frase-combinada';
  process.env.WA_OFICIAL_APP_SECRET = SEGREDO;

  oficial = await import('./whatsapp-oficial.js');
  regras = await import('./whatsapp-oficial-regras.js');
  const { default: rota } = await import('../routes/webhook-meta.js');

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/webhook/meta', rota);
  backend = http.createServer(app);
  urlBackend = `http://127.0.0.1:${await escutar(backend)}/webhook/meta`;
});

after(() => { meta.close(); backend.close(); });

test('modelo: endereço, token e corpo que a Meta espera', async () => {
  pedidos.length = 0;
  const r = await oficial.enviarModelo('(11) 98259-2538', 'hello_world', 'en_US');

  assert.equal(r.id, 'wamid.TESTE');
  assert.equal(r.waId, '551182592538');
  assert.equal(pedidos[0].url, '/v99.0/111222333/messages');
  assert.equal(pedidos[0].auth, 'Bearer token-de-teste');
  assert.deepEqual(pedidos[0].json, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '5511982592538',
    type: 'template',
    template: { name: 'hello_world', language: { code: 'en_US' } },
  });
});

test('modelo com campos: {{1}} e {{2}} viram parâmetros do corpo', () => {
  const corpo = regras.corpoDoModelo('11982592538', 'lembrete_aula', 'pt_BR', ['Ana', '18h']);
  assert.deepEqual(corpo.template.components, [{
    type: 'body',
    parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: '18h' }],
  }]);
});

test('texto fora da janela: o código da Meta chega a quem chamou', async () => {
  await assert.rejects(
    () => oficial.enviarTexto('5511900000000', 'oi'),
    (err) => err.codigo === 131047 && /mais de 24 h/.test(err.message),
  );
});

test('status: lê o número pelo id', async () => {
  pedidos.length = 0;
  const n = await oficial.infoDoNumero();
  assert.equal(n.quality_rating, 'GREEN');
  assert.match(pedidos[0].url, /^\/v99\.0\/111222333\?fields=/);
});

const aviso = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550000000', phone_number_id: '111222333' },
        contacts: [{ profile: { name: 'José' }, wa_id: '551182592538' }],
        messages: [{ from: '551182592538', id: 'wamid.IN', timestamp: '1795000000', type: 'text', text: { body: 'olá, tudo bem?' } }],
        statuses: [
          { id: 'wamid.OUT', status: 'delivered', timestamp: '1795000001', recipient_id: '551182592538', pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' } },
          { id: 'wamid.X', status: 'failed', timestamp: '1795000002', recipient_id: '5511900000000', errors: [{ code: 131026, title: 'Message undeliverable' }] },
        ],
      },
    }],
  }],
};

test('lerAviso: mensagem, status com preço e falha', () => {
  const [mensagem, entregue, falha] = regras.lerAviso(aviso);

  assert.equal(mensagem.tipo, 'mensagem');
  assert.equal(mensagem.de, '551182592538');
  assert.equal(mensagem.nome, 'José');
  assert.equal(mensagem.conteudo, 'olá, tudo bem?');

  assert.equal(entregue.status, 'delivered');
  assert.equal(entregue.cobrada, true);
  assert.equal(entregue.categoria, 'marketing');

  assert.equal(falha.status, 'failed');
  assert.equal(falha.cobrada, null);
  assert.deepEqual(falha.erro, { codigo: 131026, texto: 'Message undeliverable' });
});

test('lerAviso: o que não é do WhatsApp não vira nada', () => {
  assert.deepEqual(regras.lerAviso({ object: 'page', entry: [] }), []);
  assert.deepEqual(regras.lerAviso(null), []);
});

const assinar = (texto, segredo = SEGREDO) => `sha256=${createHmac('sha256', segredo).update(texto).digest('hex')}`;

test('assinatura: confere com o corpo cru, e só com ele', () => {
  const cru = JSON.stringify(aviso);
  assert.equal(regras.assinaturaConfere(Buffer.from(cru), assinar(cru), SEGREDO), true);
  assert.equal(regras.assinaturaConfere(Buffer.from(cru + ' '), assinar(cru), SEGREDO), false);
  assert.equal(regras.assinaturaConfere(Buffer.from(cru), assinar(cru, 'outro'), SEGREDO), false);
  assert.equal(regras.assinaturaConfere(Buffer.from(cru), 'sha256=abc', SEGREDO), false);
  assert.equal(regras.assinaturaConfere(Buffer.from(cru), assinar(cru), ''), false);
  assert.equal(regras.assinaturaConfere(undefined, assinar(cru), SEGREDO), false);
});

test('rota: a verificação devolve o desafio só com o token certo', async () => {
  const certo = await fetch(`${urlBackend}?hub.mode=subscribe&hub.verify_token=frase-combinada&hub.challenge=12345`);
  assert.equal(certo.status, 200);
  assert.equal(await certo.text(), '12345');

  const errado = await fetch(`${urlBackend}?hub.mode=subscribe&hub.verify_token=chute&hub.challenge=12345`);
  assert.equal(errado.status, 403);
});

test('rota: aviso assinado entra, sem assinatura ou adulterado não', async () => {
  // Com acento de propósito: a assinatura é sobre os bytes, não sobre o JSON.
  const cru = JSON.stringify(aviso);
  const mandar = (corpo, assinatura) => fetch(urlBackend, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(assinatura ? { 'X-Hub-Signature-256': assinatura } : {}) },
    body: corpo,
  });

  assert.equal((await mandar(cru, assinar(cru))).status, 200);
  assert.equal((await mandar(cru)).status, 401);
  assert.equal((await mandar(cru.replace('olá', 'oi'), assinar(cru))).status, 401);
});
