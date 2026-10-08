/**
 * O prompt do acompanhamento: a cópia de vendas.md e a base curta.
 * Lê só arquivos do repositório; sem `.env`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE_DO_ACOMPANHAMENTO, PROMPTS_DIR, PROMPT_ARQUIVO, SEM_RESPOSTA, limparPrompt, lerDaBase, montarBase,
} from './prompt.js';

const bruto = readFileSync(PROMPT_ARQUIVO, 'utf8');
const vendas = new Set(readFileSync(join(PROMPTS_DIR, 'vendas.md'), 'utf8').split('\n'));

/** As linhas entre <!-- vendas.md --> e <!-- /vendas.md -->. */
function linhasCopiadas() {
  const blocos = [...bruto.matchAll(/<!-- vendas\.md -->\n([\s\S]*?)<!-- \/vendas\.md -->/g)];
  return blocos.flatMap(b => b[1].split('\n')).filter(l => l.trim());
}

test('a personalidade é cópia literal de vendas.md, linha por linha', () => {
  const copiadas = linhasCopiadas();
  assert.ok(copiadas.length > 60, `poucas linhas copiadas (${copiadas.length})`);
  const diferentes = copiadas.filter(l => !vendas.has(l));
  assert.deepEqual(diferentes, [], 'linha copiada que não está mais igual em vendas.md: refaça a cópia');
});

test('o que é de venda ficou de fora', () => {
  const prompt = limparPrompt(bruto);
  for (const trecho of ['Nunca enviar valores de preços', 'agendamento é seu e funciona a qualquer hora']) {
    assert.ok(!prompt.includes(trecho), trecho);
  }
});

test('o que vai ao modelo começa na Leia, sem cabeçalho nem marcas', () => {
  const prompt = limparPrompt(bruto);
  assert.match(prompt, /^Você é a Leia, consultora virtual da AP Academia\./);
  assert.ok(!prompt.includes('<!--') && !prompt.includes('@@') && !prompt.includes('Prompt do caminho'));
  assert.ok(prompt.includes('**SEU MAIOR DIFERENCIAL** é a capacidade de raciocínio.'));
});

test('o prompt fala das tools do caminho e do texto de "sem resposta" que o código descarta', () => {
  const prompt = limparPrompt(bruto);
  for (const t of ['registrar_desfecho', 'encaminhar_ao_professor', 'pausar_acompanhamento', 'transferir_para_humano']) {
    assert.ok(prompt.includes(`\`${t}\``), t);
  }
  assert.ok(prompt.includes(`\`${SEM_RESPOSTA}\``));
});

test('a base é curta e cada pedaço existe nos arquivos de knowledge/', async () => {
  const base = await montarBase(lerDaBase);
  for (const { arquivo, secao } of BASE_DO_ACOMPANHAMENTO) {
    assert.ok(base.includes(secao ? `### ${arquivo} — ${secao}` : `### ${arquivo}`), arquivo);
  }
  // Curta: um terço do que o núcleo de vendas leva só em grade, informações e planos.
  assert.ok(base.length < 16_000, `base com ${base.length} caracteres`);
  // Planos e valores não entram: o arquivo não está na base, e valor nenhum aparece.
  assert.ok(!base.includes('### planos-e-valores.md') && !base.includes('R$'), 'planos e valores não entram aqui');
});

test('seção que mudou de título é erro, e não base pela metade', async () => {
  await assert.rejects(montarBase(async () => '# arquivo sem as seções'), /não está em/);
});
