/**
 * src/services/acompanhamento/prompt.js
 * O prompt e a base do caminho `acompanhamento` da Leia (etapa A3).
 *
 * O prompt mora em `src/prompts/acompanhamento.md`, com um cabeçalho para
 * quem edita (cortado aqui, na primeira linha `---`) e as marcas
 * `<!-- vendas.md -->` em volta do que é cópia literal de `vendas.md`
 * (tiradas aqui; conferidas em `acompanhamento-prompt.test.js`).
 *
 * ## A base é curta de propósito
 *
 * Pedido do responsável em 08/10/2026: só o necessário para a Leia responder
 * com clareza sem improvisar. Não é o núcleo de vendas — 36 mil tokens, com
 * planos e valores, que aqui não se discutem. São quatro pedaços, lidos dos
 * MESMOS arquivos de `knowledge/` que a Leia de vendas lê: dado da academia
 * não se copia, para não divergir. Seção que mudar de título faz o teste
 * falhar, e não a base sumir calada.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts');
export const PROMPT_ARQUIVO = join(PROMPTS_DIR, 'acompanhamento.md');

/** O que a Leia devolve depois do limite de trocas, quando não há alerta: nada sai. */
export const SEM_RESPOSTA = '[sem resposta]';

/** O limite de trocas por rodada do acompanhamento (pedido do responsável, 08/10/2026). */
export const LIMITE_DE_TROCAS = 3;

/**
 * A base deste caminho, na ordem em que entra. `secao` = só aquele `## título`
 * do arquivo; sem `secao`, o arquivo inteiro.
 */
export const BASE_DO_ACOMPANHAMENTO = [
  { arquivo: 'informacoes-gerais.md', secao: 'Horário de funcionamento' },
  { arquivo: 'operacional-adulto.md', secao: 'Agendamento das sessões' },
  { arquivo: 'grade-horaria.md' },
  { arquivo: 'suporte-fiti.md' },
];

/** O prompt que vai ao modelo: sem o cabeçalho de edição e sem as marcas de cópia. */
export function limparPrompt(bruto) {
  const corte = bruto.search(/^---\s*$/m);
  const corpo = corte < 0 ? bruto : bruto.slice(corte).replace(/^---\s*\n/, '');
  return corpo.replace(/^<!--[\s\S]*?-->\s*\n/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Um `## título` de um markdown, até o próximo `## `. null se não houver. */
export function secaoDoMarkdown(texto, titulo) {
  const linhas = texto.split('\n');
  const inicio = linhas.findIndex(l => l.trim() === `## ${titulo}`);
  if (inicio < 0) return null;
  const fim = linhas.findIndex((l, i) => i > inicio && /^## /.test(l));
  return linhas.slice(inicio, fim < 0 ? undefined : fim).join('\n').trim();
}

/**
 * Monta a base a partir de um leitor de arquivo (o de disco, ou o do teste).
 * Pedaço que não se acha é erro: base pela metade faria a Leia improvisar.
 */
export async function montarBase(ler) {
  const partes = [];
  for (const { arquivo, secao } of BASE_DO_ACOMPANHAMENTO) {
    const texto = (await ler(arquivo)).trim();
    const parte = secao ? secaoDoMarkdown(texto, secao) : texto;
    if (!parte) throw new Error(`base do acompanhamento: "${secao}" não está em ${arquivo}`);
    partes.push(secao ? `### ${arquivo} — ${secao}\n\n${parte}` : `### ${arquivo}\n\n${parte}`);
  }
  return ['# BASE DE CONHECIMENTO — ACOMPANHAMENTO', ...partes].join('\n\n');
}

export const lerDaBase = (arquivo) => readFile(join(PROMPTS_DIR, 'knowledge', arquivo), 'utf-8');

/** O prompt e a base, do disco. */
export async function carregarPromptEBase() {
  const [bruto, base] = await Promise.all([readFile(PROMPT_ARQUIVO, 'utf-8'), montarBase(lerDaBase)]);
  return { prompt: limparPrompt(bruto), base };
}
