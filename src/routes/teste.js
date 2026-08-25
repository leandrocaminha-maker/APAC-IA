/**
 * src/routes/teste.js
 * Sandbox web do agente — a página que o time usa para conversar com a Leia
 * sem passar pelo WhatsApp.
 *
 * Por que existe: testar pelo WhatsApp exige parear o número da academia e
 * mistura o teste com o histórico real do cliente. Aqui cada aba de navegador
 * vira um "contato" próprio, num canal separado (`channel = 'web-test'`), então
 * o histórico de teste fica gravado para análise sem se confundir com o
 * atendimento de verdade nem sujar as métricas.
 *
 * Autenticação: uma senha só, sem usuário (config.teste.senha). É uma sala de
 * testes exposta por IP, não um painel — por isso o acesso é limitado por
 * tentativa, por intervalo entre mensagens e por teto diário: cada resposta
 * gasta crédito de API.
 */
import { Router } from 'express';
import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { aiAgent } from '../services/ai-agent.js';
import { saveMessage } from '../services/contacts.js';

const router = Router();

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PAGINA = join(__dirname, '..', 'public', 'teste.html');

const COOKIE = 'apac_teste';
const CANAL = 'web-test';
const SESSAO_MS = 12 * 60 * 60 * 1000;
const MAX_CHARS = 800;
const INTERVALO_MIN_MS = 1200;
const MAX_TENTATIVAS_LOGIN = 8;
const JANELA_TENTATIVAS_MS = 15 * 60 * 1000;

// Segredo de assinatura do cookie. Sem TESTE_SESSION_SECRET no .env ele é
// sorteado no boot — funciona, mas derruba as sessões a cada restart.
const SEGREDO = config.teste.sessionSecret || randomBytes(32).toString('hex');

// Estado em memória. É um container só; se um dia virar mais de um, estes
// contadores passam a valer por instância e os tetos afrouxam na mesma medida.
const tentativasPorIp = new Map();   // ip  → { count, resetAt }
const ultimaMsgPorSid = new Map();   // sid → timestamp
const msgsPorSid = new Map();        // sid → count
let usoDoDia = { dia: null, count: 0 };

// ──────────────────────────────────────────────
// Sessão (cookie assinado — sem store, sem dependência nova)
// ──────────────────────────────────────────────

function assinar(payload) {
  const corpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
  return `${corpo}.${mac}`;
}

function verificar(token) {
  if (!token || !token.includes('.')) return null;

  const [corpo, mac] = token.split('.');
  const esperado = createHmac('sha256', SEGREDO).update(corpo).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    if (!payload.sid || Date.now() - payload.iat > SESSAO_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function lerCookie(req, nome) {
  const bruto = req.headers.cookie;
  if (!bruto) return null;

  for (const parte of bruto.split(';')) {
    const [chave, ...valor] = parte.trim().split('=');
    if (chave === nome) return decodeURIComponent(valor.join('='));
  }
  return null;
}

/** Comparação em tempo constante mesmo com senhas de tamanhos diferentes. */
function senhaConfere(enviada) {
  const a = createHash('sha256').update(String(enviada)).digest();
  const b = createHash('sha256').update(config.teste.senha).digest();
  return timingSafeEqual(a, b);
}

/**
 * Fail-closed: `TESTE_SENHA=` vazio no .env faria a comparação bater com
 * string vazia e a página abriria para qualquer um que clicasse em Entrar.
 * Sem senha, a página não existe.
 */
function paginaNoAr() {
  return config.teste.habilitada && Boolean(config.teste.senha);
}

function exigirSessao(req, res, next) {
  if (!paginaNoAr()) {
    return res.status(404).json({ erro: 'Página de teste desabilitada' });
  }

  const sessao = verificar(lerCookie(req, COOKIE));
  if (!sessao) return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' });

  req.sessao = sessao;
  next();
}

// ──────────────────────────────────────────────
// Contato e conversa do testador
// ──────────────────────────────────────────────

/**
 * Um contato por sessão de navegador. O telefone é sintético (`teste-<sid>`)
 * de propósito: respeita a UNIQUE da tabela sem colidir com número real, e
 * deixa óbvio na análise que aquela linha veio da página de teste.
 */
async function contatoDaSessao(sid) {
  const phone = `teste-${sid}`;

  const { data: existente } = await supabase
    .from('wa_contacts')
    .select('*')
    .eq('phone', phone)
    .single();

  if (existente) return existente;

  const { data, error } = await supabase
    .from('wa_contacts')
    .insert({
      phone,
      name: null,
      is_prospect: true,
      tags: ['teste-web'],
      metadata: { origem: 'pagina-de-teste' },
    })
    .select()
    .single();

  if (error) throw new Error(`não foi possível criar o contato de teste: ${error.message}`);

  logger.info(`[teste] Novo testador: ${phone}`);
  return data;
}

async function conversaDoTestador(contactId) {
  const { data: existente } = await supabase
    .from('wa_conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('channel', CANAL)
    .in('status', ['active', 'human'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existente) {
    await supabase
      .from('wa_conversations')
      .update({ last_message: new Date().toISOString() })
      .eq('id', existente.id);
    return existente;
  }

  const { data, error } = await supabase
    .from('wa_conversations')
    .insert({
      contact_id: contactId,
      status: 'active',
      channel: CANAL,
      ai_enabled: true,
      context: { origem: 'pagina-de-teste' },
    })
    .select()
    .single();

  if (error) throw new Error(`não foi possível abrir a conversa de teste: ${error.message}`);
  return data;
}

/**
 * Registra o handoff SEM desligar a IA.
 *
 * No WhatsApp o handoff encerra o turno do bot e um humano assume. Aqui isso
 * mataria o teste no primeiro "vou chamar um consultor" — e é justamente
 * depois desse ponto que o roteiro precisa ser avaliado. Então gravamos o
 * handoff (o dado mais valioso da análise: onde o bot desiste) e deixamos a
 * conversa seguir, com aviso visível na tela.
 */
async function registrarHandoff(conversationId, contactId, motivo) {
  const { error } = await supabase
    .from('wa_human_handoffs')
    .insert({
      conversation_id: conversationId,
      contact_id: contactId,
      reason: `[teste-web] ${motivo || 'sem motivo informado'}`,
    });

  if (error) logger.error('[teste] Erro ao registrar handoff:', error.message);
}

// ──────────────────────────────────────────────
// Rotas
// ──────────────────────────────────────────────

/** GET /teste — a página em si */
router.get('/', async (req, res) => {
  if (!paginaNoAr()) return res.status(404).send('Página de teste desabilitada.');

  try {
    const html = await readFile(PAGINA, 'utf-8');
    res.type('html').send(html);
  } catch (err) {
    logger.error('[teste] Falha ao ler teste.html:', err.message);
    res.status(500).send('Página de teste indisponível.');
  }
});

/** POST /teste/entrar — senha única, sem usuário */
router.post('/entrar', (req, res) => {
  if (!paginaNoAr()) return res.status(404).json({ erro: 'Página de teste desabilitada' });

  const ip = req.ip || req.socket.remoteAddress || 'desconhecido';
  const agora = Date.now();
  const tentativa = tentativasPorIp.get(ip);

  if (tentativa && agora < tentativa.resetAt && tentativa.count >= MAX_TENTATIVAS_LOGIN) {
    const minutos = Math.ceil((tentativa.resetAt - agora) / 60000);
    return res.status(429).json({ erro: `Muitas tentativas. Tente de novo em ${minutos} min.` });
  }

  if (!senhaConfere(req.body?.senha || '')) {
    const atual = (tentativa && agora < tentativa.resetAt)
      ? tentativa
      : { count: 0, resetAt: agora + JANELA_TENTATIVAS_MS };
    atual.count += 1;
    tentativasPorIp.set(ip, atual);
    logger.warn(`[teste] Senha incorreta (${atual.count}/${MAX_TENTATIVAS_LOGIN}) de ${ip}`);
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }

  tentativasPorIp.delete(ip);

  const token = assinar({ sid: randomUUID(), iat: Date.now() });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/teste',
    maxAge: SESSAO_MS,
  });

  logger.info(`[teste] Sessão aberta para ${ip}`);
  res.json({ ok: true });
});

/** POST /teste/sair */
router.post('/sair', (req, res) => {
  res.clearCookie(COOKIE, { path: '/teste' });
  res.json({ ok: true });
});

/** GET /teste/sessao — estado atual + histórico, para recarregar a página sem perder o fio */
router.get('/sessao', exigirSessao, async (req, res) => {
  const contato = await contatoDaSessao(req.sessao.sid);
  const conversa = await conversaDoTestador(contato.id);

  const { data: mensagens } = await supabase
    .from('wa_messages')
    .select('direction, content, created_at')
    .eq('conversation_id', conversa.id)
    .order('created_at', { ascending: true })
    .limit(200);

  res.json({
    nome: contato.name,
    conversaId: conversa.id,
    mensagens: (mensagens || []).map(m => ({
      de: m.direction === 'inbound' ? 'voce' : 'leia',
      texto: m.content,
      em: m.created_at,
    })),
  });
});

/** POST /teste/nome — rótulo do testador (não é login: serve para saber quem testou o quê) */
router.post('/nome', exigirSessao, async (req, res) => {
  const nome = String(req.body?.nome || '').trim().slice(0, 60);
  const contato = await contatoDaSessao(req.sessao.sid);

  await supabase
    .from('wa_contacts')
    .update({ name: nome || null })
    .eq('id', contato.id);

  res.json({ ok: true, nome });
});

/** POST /teste/mensagem — o turno de conversa */
router.post('/mensagem', exigirSessao, async (req, res) => {
  const { sid } = req.sessao;
  const mensagem = String(req.body?.mensagem || '').trim();

  if (!mensagem) return res.status(400).json({ erro: 'Mensagem vazia.' });
  if (mensagem.length > MAX_CHARS) {
    return res.status(400).json({ erro: `Mensagem muito longa (máximo ${MAX_CHARS} caracteres).` });
  }

  // Tetos de uso — cada resposta custa crédito de API.
  const agora = Date.now();
  if (agora - (ultimaMsgPorSid.get(sid) || 0) < INTERVALO_MIN_MS) {
    return res.status(429).json({ erro: 'Calma aí 🙂 espere um instante entre as mensagens.' });
  }

  const usadas = msgsPorSid.get(sid) || 0;
  if (usadas >= config.teste.maxMensagensPorSessao) {
    return res.status(429).json({
      erro: `Limite de ${config.teste.maxMensagensPorSessao} mensagens nesta sessão. Saia e entre de novo para continuar.`,
    });
  }

  const hoje = new Date().toISOString().slice(0, 10);
  if (usoDoDia.dia !== hoje) usoDoDia = { dia: hoje, count: 0 };
  if (usoDoDia.count >= config.teste.maxMensagensPorDia) {
    return res.status(429).json({ erro: 'Teto diário de mensagens de teste atingido. Volte amanhã.' });
  }

  ultimaMsgPorSid.set(sid, agora);
  msgsPorSid.set(sid, usadas + 1);
  usoDoDia.count += 1;

  try {
    const contato = await contatoDaSessao(sid);
    const conversa = await conversaDoTestador(contato.id);

    const salva = await saveMessage({
      conversationId: conversa.id,
      contactId: contato.id,
      direction: 'inbound',
      content: mensagem,
      sentBy: 'teste-web',
      metadata: { canal: CANAL },
    });

    const resposta = await aiAgent.processMessage({
      message: mensagem,
      conversationId: conversa.id,
      excludeMessageId: salva?.id,
      contactInfo: {
        id: contato.id,
        name: contato.name,
        phone: 'teste (página web)',
        is_prospect: contato.is_prospect,
        tags: contato.tags,
      },
      origem: 'teste',
    });

    const houveHandoff = resposta.action === 'handoff';
    if (houveHandoff) {
      await registrarHandoff(conversa.id, contato.id, resposta.handoffReason);
    }

    await saveMessage({
      conversationId: conversa.id,
      contactId: contato.id,
      direction: 'outbound',
      content: resposta.text,
      sentBy: 'bot',
      metadata: {
        canal: CANAL,
        handoff: houveHandoff || undefined,
        motivo_handoff: resposta.handoffReason,
        tools: (resposta.toolResults || []).map(t => t.tool),
      },
    });

    res.json({
      resposta: resposta.text,
      handoff: houveHandoff,
      motivo: houveHandoff ? resposta.handoffReason : undefined,
      tools: (resposta.toolResults || []).map(t => t.tool),
    });
  } catch (err) {
    logger.error('[teste] Erro ao processar mensagem:', err);
    res.status(500).json({ erro: 'Deu erro ao falar com o agente. Veja os logs do servidor.' });
  }
});

/** POST /teste/reiniciar — fecha a conversa e começa outra do zero */
router.post('/reiniciar', exigirSessao, async (req, res) => {
  const contato = await contatoDaSessao(req.sessao.sid);

  await supabase
    .from('wa_conversations')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('contact_id', contato.id)
    .eq('channel', CANAL)
    .in('status', ['active', 'human']);

  logger.info(`[teste] Conversa reiniciada (contato ${contato.id})`);
  res.json({ ok: true });
});

export default router;
