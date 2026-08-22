#!/usr/bin/env node
/**
 * scripts/criar-consultor.js
 * Cria (ou reseta a senha de) um consultor do painel CRM.
 *
 * Existe porque o painel só tem login por consultor e a tabela nasce
 * vazia: sem este script não há como entrar no CRM pela primeira vez.
 * Depois do primeiro administrador, os demais saem por Ajustes → Consultores.
 *
 *   node scripts/criar-consultor.js --nome "Leandro" --email leandro@ap.com --admin
 *   node scripts/criar-consultor.js --email leandro@ap.com --senha NovaSenha123
 *   node scripts/criar-consultor.js --listar
 *
 * Sem --senha, uma é sorteada e impressa uma única vez.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { hashSenha } from '../src/lib/senha.js';

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  if (i === -1) return padrao;
  const proximo = process.argv[i + 1];
  return (!proximo || proximo.startsWith('--')) ? true : proximo;
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('✖ Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * A migration 002 pode não ter sido rodada ainda. O sintoma nativo
 * (PGRST205, "not found in schema cache") parece erro de conexão e já
 * custou caro neste projeto — então traduzimos.
 */
async function conferirTabela() {
  const { error } = await supabase.from('crm_users').select('id').limit(1);
  if (error?.code === 'PGRST205' || /schema cache/i.test(error?.message || '')) {
    console.error('✖ A tabela crm_users não existe (ou não tem GRANT para service_role).');
    console.error('  Rode supabase/migrations/002_crm_schema.sql no SQL Editor do Supabase');
    console.error('  e confira que o bloco 9 (GRANTs) foi executado.');
    return false;
  }
  if (error) {
    console.error('✖ Não consegui ler crm_users:', error.message);
    return false;
  }
  return true;
}

async function listar() {
  const { data } = await supabase
    .from('crm_users')
    .select('id, name, email, role, active, last_login_at')
    .order('name');

  if (!data?.length) {
    console.log('Nenhum consultor cadastrado ainda.');
    return;
  }

  console.log(`\n${data.length} consultor(es):\n`);
  for (const u of data) {
    const ultimo = u.last_login_at
      ? new Date(u.last_login_at).toLocaleString('pt-BR')
      : 'nunca entrou';
    console.log(`  ${u.active ? '●' : '○'} ${u.name.padEnd(24)} ${u.email.padEnd(30)} ${u.role.padEnd(10)} ${ultimo}`);
  }
  console.log();
}

async function principal() {
  if (!(await conferirTabela())) return false;

  if (arg('listar')) { await listar(); return true; }

  const email = String(arg('email') || '').trim().toLowerCase();
  if (!email || email === 'true') {
    console.error('Uso: node scripts/criar-consultor.js --nome "Nome" --email pessoa@ap.com [--senha X] [--admin]');
    console.error('     node scripts/criar-consultor.js --listar');
    return false;
  }

  const senha = arg('senha') === true || !arg('senha')
    ? randomBytes(9).toString('base64url')
    : String(arg('senha'));

  if (senha.length < 8) {
    console.error('✖ A senha precisa de pelo menos 8 caracteres.');
    return false;
  }

  const papel = arg('admin') ? 'admin' : 'consultor';
  const password_hash = await hashSenha(senha);

  const { data: existente } = await supabase
    .from('crm_users')
    .select('id, name')
    .eq('email', email)
    .maybeSingle();

  if (existente) {
    const update = { password_hash, active: true };
    if (arg('nome') && arg('nome') !== true) update.name = String(arg('nome'));
    if (arg('admin')) update.role = 'admin';

    const { error } = await supabase.from('crm_users').update(update).eq('id', existente.id);
    if (error) { console.error('✖', error.message); return false; }

    console.log(`\n✔ Senha de ${existente.name} (${email}) redefinida.`);
  } else {
    const nome = arg('nome') && arg('nome') !== true ? String(arg('nome')) : email.split('@')[0];

    const { error } = await supabase
      .from('crm_users')
      .insert({ name: nome, email, password_hash, role: papel });

    if (error) { console.error('✖', error.message); return false; }

    console.log(`\n✔ Consultor "${nome}" criado como ${papel}.`);
  }

  console.log(`\n   E-mail: ${email}`);
  console.log(`   Senha:  ${senha}`);
  console.log('\n   Anote agora — a senha não é recuperável, só redefinível.');
  console.log('   Entre em https://crm.apacademia.com.br\n');
  return true;
}

// `process.exitCode` em vez de `process.exit()`: o cliente do Supabase
// mantém handles abertos, e encerrar à força no meio disso derruba o
// processo com assertion do libuv no Windows — depois de já ter impresso a
// saída, o que faz o script parecer quebrado quando ele funcionou.
principal()
  .then(ok => { process.exitCode = ok ? 0 : 1; })
  .catch(err => {
    console.error('✖ Falhou:', err.message);
    process.exitCode = 1;
  });
