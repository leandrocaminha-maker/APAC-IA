/**
 * src/services/crm-auth.js
 * Login do painel CRM — senha por consultor.
 *
 * **Cookie assinado, sem store de sessão.** É o mesmo mecanismo já
 * validado na /teste. Não há tabela de sessões para limpar, e o logout do
 * lado do servidor é trocar o segredo. O custo é não conseguir revogar uma
 * sessão específica antes de ela expirar — aceitável para um painel de
 * time pequeno atrás de TLS.
 *
 * O hash de senha em si mora em lib/senha.js, sem depender de banco: o
 * script que cria o primeiro consultor precisa dele e nada mais.
 */
import { randomBytes, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { hashSenha, conferirSenha } from '../lib/senha.js';

export { hashSenha, conferirSenha };

const COOKIE = 'apac_crm';
const SESSAO_MS = config.crm.sessaoHoras * 60 * 60 * 1000;

// Segredo de assinatura. Sem CRM_SESSION_SECRET no .env ele é sorteado no
// boot — funciona, mas derruba todas as sessões a cada restart do container.
const SEGREDO = config.crm.sessionSecret || randomBytes(32).toString('hex');

// Tentativas de login por IP, em memória. Um container só; se um dia virar
// mais de um, o teto passa a valer por instância.
const tentativasPorIp = new Map();
const MAX_TENTATIVAS = 10;
const JANELA_MS = 15 * 60 * 1000;

// ──────────────────────────────────────────────
// Cookie de sessão
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
    if (!payload.uid || Date.now() - payload.iat > SESSAO_MS) return null;
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

// ──────────────────────────────────────────────
// Login
// ──────────────────────────────────────────────

/**
 * Autentica um consultor.
 * @returns {Promise<{ok:true, usuario:object, token:string} | {ok:false, erro:string, status:number}>}
 */
export async function login(email, senha, ip = 'desconhecido') {
  const agora = Date.now();
  const tentativa = tentativasPorIp.get(ip);

  if (tentativa && agora < tentativa.resetAt && tentativa.count >= MAX_TENTATIVAS) {
    const minutos = Math.ceil((tentativa.resetAt - agora) / 60000);
    return { ok: false, status: 429, erro: `Muitas tentativas. Tente de novo em ${minutos} min.` };
  }

  function registrarFalha() {
    const atual = (tentativa && agora < tentativa.resetAt)
      ? tentativa
      : { count: 0, resetAt: agora + JANELA_MS };
    atual.count += 1;
    tentativasPorIp.set(ip, atual);
  }

  const emailNormalizado = String(email || '').trim().toLowerCase();

  const { data: usuario } = await supabase
    .from('crm_users')
    .select('id, email, name, password_hash, role, active')
    .eq('email', emailNormalizado)
    .maybeSingle();

  // Mesmo texto e mesmo caminho para "não existe" e "senha errada": a
  // diferença entregaria quais e-mails têm conta. E conferimos a senha
  // contra um hash descartável quando o usuário não existe, para o tempo
  // de resposta não denunciar a diferença.
  if (!usuario || !usuario.active) {
    await conferirSenha(senha, await hashSenha(randomUUID()));
    registrarFalha();
    logger.warn(`[crm-auth] Login negado para "${emailNormalizado}" de ${ip}`);
    return { ok: false, status: 401, erro: 'E-mail ou senha incorretos.' };
  }

  if (!(await conferirSenha(senha, usuario.password_hash))) {
    registrarFalha();
    logger.warn(`[crm-auth] Senha incorreta para "${emailNormalizado}" de ${ip}`);
    return { ok: false, status: 401, erro: 'E-mail ou senha incorretos.' };
  }

  tentativasPorIp.delete(ip);

  await supabase
    .from('crm_users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', usuario.id);

  logger.info(`[crm-auth] ${usuario.name} (${usuario.email}) entrou`);

  return {
    ok: true,
    usuario: { id: usuario.id, nome: usuario.name, email: usuario.email, papel: usuario.role },
    token: assinar({ uid: usuario.id, iat: Date.now() }),
  };
}

/** Grava o cookie de sessão na resposta. */
export function gravarCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/crm',
    maxAge: SESSAO_MS,
  });
}

/** Apaga o cookie de sessão. */
export function limparCookie(res) {
  res.clearCookie(COOKIE, { path: '/crm' });
}

// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────

/**
 * Exige sessão válida e carrega o consultor em `req.usuario`.
 *
 * Relê o usuário no banco a cada requisição em vez de confiar no que está
 * no cookie: é o que faz desativar um consultor ter efeito imediato, sem
 * esperar a sessão de 12h expirar.
 */
export async function exigirLogin(req, res, next) {
  if (!config.crm.habilitado) {
    return res.status(404).json({ erro: 'Painel desabilitado' });
  }

  const sessao = verificar(lerCookie(req, COOKIE));
  if (!sessao) return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' });

  const { data: usuario } = await supabase
    .from('crm_users')
    .select('id, email, name, role, active')
    .eq('id', sessao.uid)
    .maybeSingle();

  if (!usuario || !usuario.active) {
    limparCookie(res);
    return res.status(401).json({ erro: 'Conta inativa. Fale com o administrador.' });
  }

  req.usuario = { id: usuario.id, nome: usuario.name, email: usuario.email, papel: usuario.role };
  next();
}

/** Exige papel de admin (gestão de consultores, conexão do WhatsApp). */
export function exigirAdmin(req, res, next) {
  if (req.usuario?.papel !== 'admin') {
    return res.status(403).json({ erro: 'Só administradores podem fazer isso.' });
  }
  next();
}

export const crmAuth = {
  hashSenha, conferirSenha, login, gravarCookie, limparCookie,
  exigirLogin, exigirAdmin, COOKIE,
};
