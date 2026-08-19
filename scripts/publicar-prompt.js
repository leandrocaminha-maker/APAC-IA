/**
 * Publica src/prompts/vendas.md em wa_ai_prompts.system_prompt (slug `vendas`).
 *
 * Existe porque o agente lê o prompt do BANCO, não do arquivo — os knowledge
 * files é que são lidos do disco. Sem este passo, editar `vendas.md` não muda
 * nada no atendimento, e as duas versões divergem em silêncio (foi o que
 * aconteceu entre 15/08 e 19/08 de 2026: o arquivo tinha o dobro do tamanho do
 * que estava no ar).
 *
 * O cabeçalho do .md (as linhas de orientação para quem edita, antes do
 * "Você é a Leia") não vai para o banco: é instrução para humano, não para o
 * modelo.
 *
 * A versão anterior é salva em data/backups/ antes de sobrescrever.
 *
 * Uso:
 *   npm run prompt              # publica
 *   npm run prompt -- --dry     # só compara, não grava
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARQUIVO = join(ROOT, 'src', 'prompts', 'vendas.md');
const BACKUPS = join(ROOT, 'data', 'backups');
const SLUG = 'vendas';

const simulacao = process.argv.includes('--dry');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.');
  process.exit(1);
}

// ── Conteúdo do arquivo, sem o cabeçalho de edição ──
const bruto = readFileSync(ARQUIVO, 'utf-8');
const inicio = bruto.indexOf('Você é a Leia');

if (inicio < 0) {
  console.error('Não achei a linha "Você é a Leia" em vendas.md — o arquivo mudou de formato?');
  process.exit(1);
}

const novo = bruto.slice(inicio).trim();

// ── Banco ──
const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: atual, error } = await supabase
  .from('wa_ai_prompts')
  .select('id, system_prompt, updated_at')
  .eq('slug', SLUG)
  .single();

if (error) {
  console.error(`Não encontrei o prompt "${SLUG}" no banco:`, error.message);
  process.exit(1);
}

if (atual.system_prompt.trim() === novo) {
  console.log('O banco já está igual ao arquivo. Nada a fazer.');
} else {
  console.log(`Prompt "${SLUG}" (id ${atual.id})`);
  console.log(`  no banco:   ${atual.system_prompt.length} chars (atualizado em ${atual.updated_at})`);
  console.log(`  no arquivo: ${novo.length} chars`);

  if (simulacao) {
    console.log('\n--dry: nada foi gravado.');
  } else {
    // Backup antes de sobrescrever — o prompt é o comportamento do agente inteiro.
    mkdirSync(BACKUPS, { recursive: true });
    const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(BACKUPS, `prompt-${SLUG}-${carimbo}.md`);
    writeFileSync(backup, atual.system_prompt, 'utf-8');

    const { error: erroUpdate } = await supabase
      .from('wa_ai_prompts')
      .update({ system_prompt: novo, is_active: true })
      .eq('id', atual.id);

    if (erroUpdate) {
      console.error('Falha ao gravar:', erroUpdate.message);
      process.exit(1);
    }

    console.log(`\nPublicado. Versão anterior salva em data/backups/${backup.split(/[\\/]/).pop()}`);
    console.log('O agente recarrega em até 5 minutos, ou na hora com POST /admin/reload-cache.');
  }
}
