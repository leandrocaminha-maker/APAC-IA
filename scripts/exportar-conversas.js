/**
 * Exporta o histórico de conversas do Supabase para arquivos locais, para
 * análise e ajuste do prompt e da base de conhecimento.
 *
 * Gera dois arquivos em data/conversas/:
 *   - transcricoes.md  → legível, uma seção por conversa, com os handoffs
 *                        marcados na linha em que aconteceram
 *   - conversas.json   → o mesmo conteúdo cru, para cruzar números
 *
 * Telefone de cliente é mascarado por padrão (fica só o final). Os arquivos
 * saem em data/conversas/, que está no .gitignore: conversa de cliente não
 * entra no repositório.
 *
 * Uso:
 *   npm run conversas                    # tudo dos últimos 30 dias
 *   npm run conversas -- --canal=web-test  # só a página de teste
 *   npm run conversas -- --dias=7
 *   npm run conversas -- --com-telefone  # sem mascarar (evite)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAIDA = join(ROOT, 'data', 'conversas');

// ── Argumentos ────────────────────────────────
const args = process.argv.slice(2);
const arg = (nome, padrao) => {
  const achado = args.find(a => a.startsWith(`--${nome}=`));
  return achado ? achado.split('=').slice(1).join('=') : padrao;
};
const dias = parseInt(arg('dias', '30'), 10);
const canal = arg('canal', 'todos');
const mascarar = !args.includes('--com-telefone');

const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

// ── Supabase ──────────────────────────────────
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.');
  console.error('Rode este script na máquina que tem o .env do projeto (ou copie as duas variáveis).');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

function telefone(bruto) {
  if (!bruto) return 'sem telefone';
  if (bruto.startsWith('teste-')) return 'página de teste';
  if (!mascarar) return bruto;
  return `***${bruto.slice(-4)}`;
}

function horario(iso) {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// ── Coleta ────────────────────────────────────
let consulta = supabase
  .from('wa_conversations')
  .select('id, status, channel, started_at, last_message, contact_id, wa_contacts ( name, phone, tags )')
  .gte('started_at', desde)
  .order('started_at', { ascending: true });

if (canal !== 'todos') consulta = consulta.eq('channel', canal);

const { data: conversas, error } = await consulta;

if (error) {
  console.error('Erro ao buscar conversas:', error.message);
  process.exit(1);
}

if (!conversas.length) {
  console.log(`Nenhuma conversa nos últimos ${dias} dias (canal: ${canal}).`);
  process.exit(0);
}

const ids = conversas.map(c => c.id);

const { data: mensagens } = await supabase
  .from('wa_messages')
  .select('conversation_id, direction, content, sent_by, metadata, created_at')
  .in('conversation_id', ids)
  .order('created_at', { ascending: true });

const { data: handoffs } = await supabase
  .from('wa_human_handoffs')
  .select('conversation_id, reason, resolved, created_at')
  .in('conversation_id', ids);

// ── Montagem ──────────────────────────────────
const porConversa = new Map(ids.map(id => [id, { mensagens: [], handoffs: [] }]));
for (const m of mensagens || []) porConversa.get(m.conversation_id)?.mensagens.push(m);
for (const h of handoffs || []) porConversa.get(h.conversation_id)?.handoffs.push(h);

const linhas = [];
const registro = [];

linhas.push('# Transcrições de conversas — AP Academia');
linhas.push('');
linhas.push(`> Geradas em ${horario(new Date().toISOString())} · últimos ${dias} dias · canal: ${canal}`);
linhas.push('> Uso interno: contém conversa de cliente. Não commitar, não compartilhar fora da equipe.');
linhas.push('');

let totalMsgs = 0;
let comHandoff = 0;
const motivos = new Map();

for (const c of conversas) {
  const { mensagens: msgs, handoffs: hs } = porConversa.get(c.id);
  if (!msgs.length) continue;

  totalMsgs += msgs.length;
  if (hs.length) comHandoff += 1;
  for (const h of hs) {
    const motivo = (h.reason || 'sem motivo').replace('[teste-web] ', '');
    motivos.set(motivo, (motivos.get(motivo) || 0) + 1);
  }

  const contato = c.wa_contacts || {};
  const quem = contato.name || 'sem nome';

  linhas.push('---');
  linhas.push('');
  linhas.push(`## Conversa ${c.id} — ${quem} (${telefone(contato.phone)})`);
  linhas.push('');
  linhas.push(`Canal: ${c.channel} · status: ${c.status} · início: ${horario(c.started_at)} · ` +
    `${msgs.length} mensagens · ${hs.length} handoff(s)`);
  linhas.push('');

  for (const m of msgs) {
    const autor = m.direction === 'inbound' ? 'CLIENTE' : 'LEIA';
    const hora = new Date(m.created_at).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const tools = m.metadata?.tools?.length ? `  _[tools: ${m.metadata.tools.join(', ')}]_` : '';
    linhas.push(`**${autor}** _(${hora})_: ${String(m.content).replace(/\n/g, '\n> ')}${tools}`);
    if (m.metadata?.handoff) {
      linhas.push(`> 🤝 **HANDOFF** — ${m.metadata.motivo_handoff || 'sem motivo'}`);
    }
    linhas.push('');
  }

  registro.push({
    id: c.id,
    canal: c.channel,
    status: c.status,
    contato: { nome: contato.name, telefone: telefone(contato.phone), tags: contato.tags },
    iniciada_em: c.started_at,
    handoffs: hs,
    mensagens: msgs.map(m => ({
      de: m.direction === 'inbound' ? 'cliente' : 'leia',
      texto: m.content,
      enviado_por: m.sent_by,
      em: m.created_at,
      tools: m.metadata?.tools || [],
      handoff: m.metadata?.handoff || false,
    })),
  });
}

mkdirSync(SAIDA, { recursive: true });
writeFileSync(join(SAIDA, 'transcricoes.md'), linhas.join('\n'), 'utf-8');
writeFileSync(join(SAIDA, 'conversas.json'), JSON.stringify(registro, null, 2), 'utf-8');

// ── Resumo ────────────────────────────────────
const taxa = registro.length ? Math.round((comHandoff / registro.length) * 100) : 0;

console.log(`\n${registro.length} conversas · ${totalMsgs} mensagens · ${comHandoff} com handoff (${taxa}%)`);

if (motivos.size) {
  console.log('\nMotivos de handoff mais frequentes:');
  [...motivos.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([motivo, n]) => console.log(`  ${String(n).padStart(3)}x  ${motivo}`));
}

console.log(`\nArquivos gerados em data/conversas/`);
console.log('  transcricoes.md  — para ler e analisar');
console.log('  conversas.json   — para cruzar números');
