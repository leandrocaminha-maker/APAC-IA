/**
 * src/services/knowledge.js
 * Base de conhecimento do agente, dividida em módulos.
 *
 * Antes desta divisão os 9 arquivos iam juntos em TODA mensagem: 38.038
 * tokens, medidos com `count_tokens` contra o `claude-opus-5` em 24/08/2026.
 * Isso significa que os 9.647 tokens de metodologia da natação infantil
 * viajavam junto de quem perguntou o preço da musculação, e os 4.133 de
 * contrato e app FITI viajavam junto de quem ainda nem é aluno.
 *
 * Agora o núcleo vai sempre e o resto entra por sinal da conversa.
 *
 * ## O que NUNCA sai do contexto
 *
 * O núcleo é o que qualquer conversa pode precisar já na primeira frase:
 * endereço, horário de funcionamento, preços, o que é cada aula e a grade.
 * Nada aqui depende de saber quem é a pessoa.
 *
 * ## Por que os módulos são "pegajosos"
 *
 * A detecção roda sobre a conversa inteira que está na janela de histórico,
 * não só sobre a última mensagem. Quem disse "é para o meu filho de 4 anos"
 * na segunda mensagem continua com o módulo infantil carregado na décima,
 * mesmo falando de outra coisa no meio. Sem isso o módulo entraria e sairia
 * a cada turno — e cada entrada/saída é um prefixo de cache diferente, que
 * é justamente o que encarece.
 *
 * Quando o sinal sai da janela de histórico, o que segura o módulo é o
 * `context.knowledge` gravado em `wa_conversations` (ver `modulosFixados`).
 *
 * ## Falso positivo é barato, falso negativo não é
 *
 * A detecção erra para o lado de carregar demais de propósito. Carregar o
 * módulo infantil para quem falou "faz 2 anos que não treino" custa tokens;
 * NÃO carregar para quem perguntou de natação para bebê faz o agente
 * transferir para humano sem necessidade — ou, pior, improvisar.
 *
 * A rede de segurança do falso negativo é a tool `carregar_base`: o próprio
 * modelo pede o módulo que falta, e ele entra no contexto (e no cache) a
 * partir da chamada seguinte.
 *
 * ## Ordem é contrato de cache
 *
 * Os módulos são montados sempre na mesma ordem (`ORDEM_MODULOS`) e os
 * arquivos dentro de cada um em ordem alfabética. Um mesmo conjunto de
 * módulos tem que produzir os mesmos bytes em toda chamada de todo cliente,
 * senão cada conversa vira uma entrada de cache própria e o custo sobe em
 * vez de cair.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const KNOWLEDGE_DIR = join(__dirname, '..', 'prompts', 'knowledge');

// Ordem fixa de montagem. Mexer nela invalida o cache de todos os módulos.
export const ORDEM_MODULOS = ['nucleo', 'adulto', 'infantil', 'matriculado'];

/**
 * Arquivos de cada módulo, em ordem alfabética.
 *
 * Um arquivo novo na pasta NÃO entra sozinho — precisa ser listado aqui.
 * É proposital: a alternativa (varrer o diretório) foi o que fazia todo
 * arquivo novo virar custo em toda conversa, sem ninguém decidir isso.
 */
export const MODULOS = {
  // Sempre carregado.
  nucleo: [
    'atividades.md',
    'grade-horaria.md',
    'informacoes-gerais.md',
    'planos-e-valores.md',
  ],

  // Também sempre carregado, e separado do núcleo só para deixar explícito
  // que é material de público 13+. A anamnese é o que o roteiro de vendas
  // usa nos passos 3 e 5 para recomendar plano; sem ela o agente apresenta
  // solução sem ter qualificado. `operacional-adulto` responde "como
  // funciona o agendamento?", que o prompt proíbe transferir para humano.
  adulto: [
    'anamnese-perfil-cliente.md',
    'operacional-adulto.md',
  ],

  // Metodologia, níveis e objeções da escola infantil e de bebês.
  // O maior arquivo da base (9.647 tokens) e o mais restrito em público.
  infantil: [
    'base-conhecimento-natacao-infantil.md',
  ],

  // Assunto de quem JÁ é aluno: contrato, férias, atestado, cancelamento,
  // e os erros do app FITI. Nada disso aparece numa venda nova.
  matriculado: [
    'contrato-resumo.md',
    'suporte-fiti.md',
  ],
};

// Módulos que entram em toda conversa, independente de sinal.
const SEMPRE = ['nucleo', 'adulto'];

// ──────────────────────────────────────────────
// Detecção por sinal
// ──────────────────────────────────────────────

/**
 * Sinais de que a conversa é sobre criança.
 *
 * `filho`/`filha` cobrem "filhos", "filhinha" etc. porque a busca é por
 * substring — o que aqui é desejável.
 */
const SINAIS_INFANTIL = [
  'bebe', 'bebes', 'crianca', 'criancas', 'filho', 'filha',
  'infantil', 'kids', 'escolinha', 'meu menino', 'minha menina',
  'meu neto', 'minha neta', 'natacao para bebe', 'adaptacao ao meio liquido',
  'meu pequeno', 'minha pequena', 'aluno mirim',
];

/**
 * Sinais de que a conversa é de aluno matriculado / suporte.
 *
 * Ficam fora daqui os termos que aparecem tanto em venda quanto em suporte
 * sem distinguir nada ("plano", "horario", "agendar"). "Cancelar" ficou:
 * ele também aparece em "cancelar a aula experimental", mas o custo do
 * falso positivo são 4.133 tokens, e o do falso negativo é o agente falando
 * de rescisão contratual sem ter o contrato na frente.
 */
const SINAIS_MATRICULADO = [
  'ja sou aluno', 'ja sou aluna', 'sou aluno', 'sou aluna',
  'cancelar', 'cancelamento', 'rescisao', 'rescindir',
  'trancar', 'trancamento', 'afastamento', 'atestado',
  'ferias do plano', 'suspender o plano', 'suspensao',
  'fiti', 'aplicativo', 'nao consigo agendar', 'nao consigo entrar',
  'minha mensalidade', 'minha turma', 'trocar de horario', 'trocar de turma',
  'meu contrato', 'meu plano', 'esqueci minha senha',
];

/** Remove acentos e baixa a caixa, para a busca não depender de digitação. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Idade citada que sugere criança.
 *
 * Pega "4 anos", "3 aninhos", "de 5 ano". O teto de 12 é o mesmo corte que
 * a `anamnese-perfil-cliente.md` usa ("a partir de 13 anos").
 */
function citaIdadeInfantil(texto) {
  for (const m of texto.matchAll(/\b(\d{1,2})\s*(?:anos?|aninhos?)\b/g)) {
    if (Number(m[1]) <= 12) return true;
  }
  return false;
}

/**
 * Decide quais módulos a conversa precisa.
 *
 * @param {object} params
 * @param {string[]} [params.textos] - Mensagens da conversa (histórico + atual).
 * @param {boolean} [params.isProspect] - `false` só quando confirmado aluno.
 * @param {string[]} [params.fixados] - Módulos já travados nesta conversa
 *   (`wa_conversations.context.knowledge`), normalmente porque o próprio
 *   modelo pediu via `carregar_base`.
 * @returns {string[]} Módulos em `ORDEM_MODULOS`.
 */
export function detectarModulos({ textos = [], isProspect, fixados = [] } = {}) {
  const ativos = new Set(SEMPRE);

  for (const m of fixados) {
    if (MODULOS[m]) ativos.add(m);
  }

  // `is_prospect === false` é o único sinal de matrícula confirmado que o
  // sistema tem hoje (ver o comentário em `buildDynamicContext`).
  if (isProspect === false) ativos.add('matriculado');

  const texto = normalizar(textos.join('\n'));

  if (SINAIS_INFANTIL.some(s => texto.includes(s)) || citaIdadeInfantil(texto)) {
    ativos.add('infantil');
  }
  if (SINAIS_MATRICULADO.some(s => texto.includes(s))) {
    ativos.add('matriculado');
  }

  return ORDEM_MODULOS.filter(m => ativos.has(m));
}

// ──────────────────────────────────────────────
// Leitura e montagem
// ──────────────────────────────────────────────

// Cache por ARQUIVO, não por combinação de módulos: são 9 arquivos e até 4
// combinações, e guardar por arquivo evita reler o mesmo .md quatro vezes.
const arquivos = new Map(); // nome -> { texto, lidoEm }
const CACHE_MS = 5 * 60 * 1000;

async function lerArquivo(nome) {
  const agora = Date.now();
  const guardado = arquivos.get(nome);
  if (guardado && (agora - guardado.lidoEm) < CACHE_MS) return guardado.texto;

  const texto = (await readFile(join(KNOWLEDGE_DIR, nome), 'utf-8')).trim();
  arquivos.set(nome, { texto, lidoEm: agora });
  return texto;
}

/**
 * Bloco usado quando a base não pôde ser carregada.
 * Sem ele o modelo ficaria sem nenhuma instrução sobre preços/horários e
 * tenderia a inventar valores.
 */
const GUARDA_SEM_BASE = '\n\n## BASE DE CONHECIMENTO\n' +
  'A base de conhecimento não pôde ser carregada nesta conversa. Você NÃO tem ' +
  'nenhum dado de planos, valores ou grade horária. É proibido inventar ou ' +
  'estimar qualquer informação desse tipo — use transferir_para_humano.';

/** Nome legível de cada módulo, para o índice que o modelo lê. */
const DESCRICAO_MODULO = {
  nucleo: 'a academia, atividades, planos e valores, grade horária',
  adulto: 'qualificação e regras de uso do plano adulto (13+)',
  infantil: 'metodologia e níveis da escola de natação infantil e bebês',
  matriculado: 'contrato, férias, atestado, cancelamento e app FITI',
};

/**
 * Monta o texto da base para um conjunto de módulos.
 *
 * O cabeçalho lista o que está e o que NÃO está carregado. Os dois lados
 * importam: sem o primeiro o modelo não sabe do que dispõe; sem o segundo
 * ele não sabe que existe um módulo a pedir, e transfere para humano em vez
 * de chamar `carregar_base`.
 *
 * @param {string[]} modulos
 * @returns {Promise<string>}
 */
export async function montarKnowledge(modulos) {
  const ativos = ORDEM_MODULOS.filter(m => modulos.includes(m));
  const ausentes = ORDEM_MODULOS.filter(m => !ativos.includes(m));

  try {
    const secoes = [];
    for (const modulo of ativos) {
      for (const nome of MODULOS[modulo]) {
        secoes.push(`\n--- Arquivo: ${nome} ---\n${await lerArquivo(nome)}`);
      }
    }

    if (secoes.length === 0) {
      logger.warn('[knowledge] Nenhum módulo resolvido — usando a guarda');
      return GUARDA_SEM_BASE;
    }

    const indice = ativos
      .map(m => `- **${m}**: ${DESCRICAO_MODULO[m]}`)
      .join('\n');

    const faltando = ausentes.length === 0 ? '' :
      '\nNÃO estão carregados agora: ' +
      ausentes.map(m => `**${m}** (${DESCRICAO_MODULO[m]})`).join('; ') + '.\n' +
      'Se o cliente perguntar sobre um desses assuntos, chame `carregar_base` ' +
      'com o módulo correspondente ANTES de responder — não transfira para ' +
      'humano só porque o material não está aqui, e não responda de memória.\n';

    return '\n\n## BASE DE CONHECIMENTO (arquivos locais)\n' +
      'As informações abaixo são a ÚNICA fonte de verdade sobre planos, valores, ' +
      'modalidades, grade horária e regras da academia. Não existe consulta a ' +
      'sistema externo para esses dados.\n' +
      'REGRA CRÍTICA: se a informação que o cliente pediu não estiver abaixo, ou ' +
      'estiver marcada como "PENDENTE", "_preencha_", "Exemplo", "XXX" ou ' +
      '"descreva aqui", esse dado AINDA NÃO ESTÁ DISPONÍVEL. Nesse caso é ' +
      'proibido inventar, estimar ou aproximar: ' +
      'diga que vai confirmar a informação exata com um consultor e use a ' +
      'ferramenta transferir_para_humano.\n\n' +
      `Módulos carregados nesta conversa:\n${indice}\n` +
      faltando +
      secoes.join('\n');
  } catch (err) {
    logger.error('[knowledge] Erro ao carregar a base:', err.message);
    return GUARDA_SEM_BASE;
  }
}

/** Limpa o cache de arquivos (usado pelo /admin/reload-cache). */
export function invalidarKnowledge() {
  arquivos.clear();
}

export const knowledge = {
  MODULOS,
  ORDEM_MODULOS,
  detectarModulos,
  montarKnowledge,
  invalidarKnowledge,
};
