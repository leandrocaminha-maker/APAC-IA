/**
 * Gera DOIS arquivos de grade a partir de data/grade-aulas.csv:
 *
 * - `grade-horaria.md` — módulo `nucleo`, vai em toda conversa.
 * - `grade-horaria-infantil.md` — módulo `infantil`, só com sinal de criança.
 *
 * O CSV é a exportação da grade do sistema (Hora;Dia;Atividade;Capacidade;Professor).
 * Os .md são o que o agente de IA lê como base de conhecimento.
 *
 * A divisão é de 26/08/2026 e tem uma razão só: a grade infantil eram 1.892
 * tokens indo em 100% das conversas, inclusive na de quem só quer musculação.
 * Quem decide o arquivo de cada seção é o campo `publico` em `SECOES`.
 *
 * A exportação é uma lista de sessões soltas, mas não é assim que se compra uma
 * vaga: na natação infantil a matrícula é sempre um PAR de dias (Seg+Qua ou
 * Ter+Qui) no mesmo horário, sábado é turma exclusiva de 1x na semana, e sexta
 * não recebe matrícula (é aula extra). O gerador remonta as sessões nesse
 * formato — senão o agente ofereceria "quarta às 19:00" como se fosse uma opção
 * de matrícula. Natação Bebê é 1x na semana e não segue essa regra.
 *
 * Uso: npm run grade
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV = join(ROOT, 'data', 'grade-aulas.csv');
const KNOWLEDGE = join(ROOT, 'src', 'prompts', 'knowledge');
const OUT_GERAL = join(KNOWLEDGE, 'grade-horaria.md');
const OUT_INFANTIL = join(KNOWLEDGE, 'grade-horaria-infantil.md');

const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
const DIA_LABEL = { Seg: 'Seg', Ter: 'Ter', Qua: 'Qua', Qui: 'Qui', Sex: 'Sex', Sab: 'Sáb' };

// Pares de matrícula da natação infantil, na ordem em que aparecem no arquivo.
const PARES = [['Seg', 'Qua'], ['Ter', 'Qui']];

const avisos = [];

// Agrupamento das atividades em seções, na ordem em que aparecem no arquivo.
//
// `regime: 'par'` = natação infantil (matrícula em par de dias).
//
// `publico` decide em QUAL ARQUIVO a seção sai, e é o motivo de este gerador
// escrever dois .md desde 26/08/2026. A grade infantil eram 1.892 tokens
// viajando em 100% das conversas, inclusive na de quem só quer musculação —
// o mesmo problema que a modularização da base já tinha resolvido. Agora ela
// sai em `grade-horaria-infantil.md`, que só entra com o módulo `infantil`.
const SECOES = [
  {
    titulo: 'Escola de Natação Infantil — turmas de 3 a 5 anos',
    publico: 'infantil',
    regime: 'par',
    nota:
      'Progressão pedagógica de 3 a 5 anos, na ordem: Adaptação → Estrelinha N1 → ' +
      'Peixinho N2 → Golfinho I → Golfinho II → Tutubarão. O nome da turma indica ' +
      'o nível de referência dela, mas **todo horário desta faixa atende todos os ' +
      'níveis de 3 a 5** — ver "Como ler a grade infantil". O conteúdo de cada ' +
      'nível e a idade de entrada estão em `base-conhecimento-natacao-infantil.md`.',
    atividades: [
      ['Natação 3-5 Adaptação', 'quem nunca teve contato com a piscina'],
      ['Natação Peixinhos N1&N2', 'níveis Estrelinha N1 e Peixinho N2'],
      ['Natação Golfinhos N3+', 'níveis Golfinho I em diante'],
    ],
  },
  {
    titulo: 'Escola de Natação Infantil — turmas de 6 a 12 anos',
    publico: 'infantil',
    regime: 'par',
    nota:
      'Progressão pedagógica de 6 a 12 anos, na ordem: N1 Branca → N2 Branca → ' +
      'N3 e N4 Amarela → N5 e N6 Laranja → N7 e N8 Vermelha → Atleta. O nome da ' +
      'turma indica o nível de referência dela, mas **todo horário desta faixa ' +
      'atende todos os níveis de 6 a 12** — ver "Como ler a grade infantil".',
    atividades: [
      ['Natação Infantil N1', 'nível N1 Branca'],
      ['Natação Infantil N1 N2', 'níveis N1 e N2 Branca'],
      ['Natação Infantil N2', 'nível N2 Branca'],
      ['Natação Infantil N3+', 'nível N3 Amarela em diante'],
      ['Natação Infantil N5+', 'nível N5 Laranja em diante'],
    ],
  },
  {
    titulo: 'Natação Bebê',
    publico: 'infantil',
    nota:
      'De **12 meses até entre 3 anos e meio e 4 anos**, **1x na semana** — cada ' +
      'horário abaixo é uma turma independente. A regra de matrícula em par de dias ' +
      'da natação infantil **não vale aqui**. ⚠️ **A criança de 3 anos é daqui, ' +
      'não do "3 a 5"** — aquelas turmas começam entre 3 anos e meio e 4 ' +
      'completos, e o nome do grupo engana. Entre 3,5 e 4 os dois são possíveis, ' +
      'e quem decide é o professor na avaliação (ver ' +
      '`base-conhecimento-natacao-infantil.md`).',
    atividades: [['Natação Bebê 1 e 2', null]],
  },
  {
    titulo: 'Natação Adulto',
    publico: 'geral',
    nota: 'A partir de 13 anos. Inclusa nos planos Estilo Aqua e Estilo de Vida Plus.',
    atividades: [['Natação Adulto', null]],
  },
  {
    titulo: 'Hidroginástica',
    publico: 'geral',
    nota: 'Inclusa nos planos Estilo Aqua e Estilo de Vida Plus.',
    atividades: [
      ['Hidroginástica', null],
      ['Hidro Zen & Meditação', null],
    ],
  },
  {
    titulo: 'Pilates Fit Studio',
    publico: 'geral',
    nota:
      'Estúdio com 8 lugares por sessão. Liberado no Estilo de Vida Plus; ' +
      'no Estilo Aqua são 8 sessões para vivenciar; não incluso no Performa.',
    atividades: [['Pilates Fit Studio', null]],
  },
  {
    titulo: 'Aulas coletivas (inclusas em todos os planos adulto)',
    publico: 'geral',
    nota: null,
    atividades: [
      ['Mat Pilates', null],
      ['Hatha Ioga', null],
      ['Alongamento + Core', null],
      ['Treinamento Funcional', null],
      ['GAP', null],
      ['Power Local', null],
      ['Cycling', null],
      ['Boxe Fitness', null],
      ['Ritmos', null],
    ],
  },
  {
    titulo: 'Funcional Kids',
    publico: 'infantil',
    nota:
      'Atividade terrestre infantil, 6 a 12 anos. Entra como combo da Escola de ' +
      'Natação (+R$ 27) ou como atividade avulsa (ver `planos-e-valores.md`).',
    atividades: [['Funcional Kids', null]],
  },
  {
    titulo: 'Avaliação e Consultoria',
    publico: 'geral',
    nota:
      'Atendimento individual (1 aluno por horário), incluso no acompanhamento ' +
      'técnico de todos os planos adulto.',
    atividades: [['Avaliação e Consultoria Avulsa', null]],
  },
];

// Musculação tem uma sessão a cada 30 min o dia inteiro: listar linha a linha
// só polui. É resumida à parte, a partir dos mesmos dados.
const MUSCULACAO = 'Musculação';

function lerCsv() {
  const linhas = readFileSync(CSV, 'utf-8').trim().split(/\r?\n/);
  return linhas.slice(1).filter(Boolean).map((linha) => {
    const [hora, dia, atividade, capacidade, professor] = linha.split(';');
    return {
      hora: hora.slice(0, 5),
      dia,
      atividade: atividade.trim(),
      capacidade: Number(capacidade),
      professor: professor.trim(),
    };
  });
}

const ordenaDia = (a, b) => DIAS.indexOf(a) - DIAS.indexOf(b);

/** hora -> dia -> [capacidades], uma entrada por turma simultânea. */
function porHorario(aulas, atividade) {
  const daAtividade = aulas.filter((a) => a.atividade === atividade);
  const mapa = new Map();
  for (const hora of [...new Set(daAtividade.map((a) => a.hora))].sort()) {
    const porDia = new Map();
    for (const dia of DIAS) {
      const turmas = daAtividade.filter((a) => a.hora === hora && a.dia === dia);
      if (turmas.length) porDia.set(dia, turmas.map((t) => t.capacidade).sort((x, y) => y - x));
    }
    mapa.set(hora, porDia);
  }
  return mapa;
}

const mesmaLotacao = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * "até 13 vagas" / "2 turmas no mesmo horário, até 16 e 12 vagas".
 *
 * O número do CSV é a capacidade do HORÁRIO, não o tamanho da turma
 * pedagógica: no mesmo horário a piscina recebe mais de uma turma, divididas
 * por nível. Os tamanhos de turma estão na base da natação infantil.
 */
function descreveTurmas(caps) {
  const vagas = `até ${caps.join(' e ')} vagas`;
  return caps.length === 1 ? vagas : `${caps.length} turmas no mesmo horário, ${vagas}`;
}

/**
 * Natação infantil: a matrícula é um par de dias no mesmo horário. Separa as
 * opções de matrícula (pares e sábado) das aulas de sexta, que não recebem
 * matrícula.
 */
function linhasEmPares(aulas, atividade) {
  const mapa = porHorario(aulas, atividade);
  const semana = [];
  const sabado = [];
  const sexta = [];

  for (const [hora, porDia] of mapa) {
    for (const [d1, d2] of PARES) {
      const c1 = porDia.get(d1);
      const c2 = porDia.get(d2);
      if (!c1 && !c2) continue;
      if (!c1 || !c2) {
        const presente = c1 ? d1 : d2;
        avisos.push(`${atividade} ${hora}: só ${presente} — par ${d1}+${d2} incompleto`);
        semana.push(`- **${DIA_LABEL[presente]}, ${hora}** — ${descreveTurmas(c1 || c2)} ⚠️ sem o dia par`);
        continue;
      }
      const turmas = mesmaLotacao(c1, c2)
        ? descreveTurmas(c1)
        : `até ${c1.join(' e ')} vagas na ${d1} e ${c2.join(' e ')} na ${d2}`;
      semana.push(`- **${DIA_LABEL[d1]} e ${DIA_LABEL[d2]}, ${hora}** — ${turmas}`);
    }
    if (porDia.has('Sab')) {
      sabado.push(`- **Sáb, ${hora}** — ${descreveTurmas(porDia.get('Sab'))}`);
    }
    if (porDia.has('Sex')) {
      sexta.push(`- **Sex, ${hora}** — ${descreveTurmas(porDia.get('Sex'))}`);
    }
  }

  // A linha em branco antes de cada lista não é estética: sem ela o
  // markdown gruda a lista no parágrafo anterior, e o arquivo é lido tanto
  // por gente quanto pelo modelo.
  const out = [];
  if (semana.length) {
    out.push('Matrícula na semana (2x, sempre nos dois dias do par):', '');
    out.push(...semana);
  }
  if (sabado.length) {
    if (out.length) out.push('');
    out.push('Turma de sábado (1x na semana, exclusiva do dia):', '');
    out.push(...sabado);
  }
  if (sexta.length) {
    if (out.length) out.push('');
    out.push('Sexta — aula extra, **não é turma de matrícula**:', '');
    out.push(...sexta);
  }
  return out;
}

/**
 * Demais modalidades: uma linha por horário, juntando os dias que têm a mesma
 * configuração de turmas.
 */
function linhasSoltas(aulas, atividade) {
  const mapa = porHorario(aulas, atividade);
  return [...mapa].map(([hora, porDia]) => {
    const grupos = new Map();
    for (const [dia, caps] of porDia) {
      const chave = caps.join('+');
      if (!grupos.has(chave)) grupos.set(chave, { caps, dias: [] });
      grupos.get(chave).dias.push(dia);
    }
    const partes = [...grupos.values()]
      .sort((a, b) => ordenaDia(a.dias[0], b.dias[0]))
      .map(({ caps, dias }) => `${dias.map((d) => DIA_LABEL[d]).join(', ')} (${descreveTurmas(caps)})`);
    return `- **${hora}** — ${partes.join(' · ')}`;
  });
}

function resumoMusculacao(aulas) {
  const musc = aulas.filter((a) => a.atividade === MUSCULACAO);
  const porDia = {};
  for (const dia of DIAS) {
    porDia[dia] = [...new Set(musc.filter((a) => a.dia === dia).map((a) => a.hora))].sort();
  }
  // dias com a mesma lista de horários viram uma linha só
  const grupos = new Map();
  for (const dia of DIAS) {
    const chave = porDia[dia].join(',');
    if (!chave) continue;
    if (!grupos.has(chave)) grupos.set(chave, { horas: porDia[dia], dias: [] });
    grupos.get(chave).dias.push(dia);
  }
  const linhas = [...grupos.values()].map(({ horas, dias }) => {
    const ultimo = dias[dias.length - 1];
    const rotulo = dias.length > 2 && ordenaDia(ultimo, dias[0]) === dias.length - 1
      ? `${DIA_LABEL[dias[0]]} a ${DIA_LABEL[ultimo]}`
      : dias.map((d) => DIA_LABEL[d]).join(', ');
    return `- **${rotulo}** — ${horas.length} sessões: ${horas.join(', ')}`;
  });
  const caps = [...new Set(musc.map((a) => a.capacidade))].sort((a, b) => a - b);
  return { linhas, min: caps[0], max: caps[caps.length - 1] };
}

/** Renderiza as seções de um público, na ordem em que estão em `SECOES`. */
function renderSecoes(aulas, publico, conhecidas) {
  const out = [];
  for (const secao of SECOES.filter((s) => s.publico === publico)) {
    const corpo = [];
    for (const [atividade, descricao] of secao.atividades) {
      conhecidas.add(atividade);
      const linhas = secao.regime === 'par'
        ? linhasEmPares(aulas, atividade)
        : linhasSoltas(aulas, atividade);
      if (!linhas.length) continue;
      corpo.push(descricao ? `### ${atividade} — ${descricao}` : `### ${atividade}`);
      corpo.push('');
      corpo.push(...linhas);
      corpo.push('');
    }
    if (!corpo.length) continue;
    out.push(`## ${secao.titulo}`, '');
    if (secao.nota) out.push(`> ${secao.nota}`, '');
    out.push(...corpo);
  }
  return out;
}

/**
 * `grade-horaria.md` — vai no núcleo, em toda conversa.
 *
 * Fica aqui só o que qualquer conversa pode precisar: como ler a grade, o
 * recorte de funcionamento e as atividades de 13 anos ou mais. As regras de
 * leitura que só valem para a infantil (tamanho de turma, par de dias, níveis
 * por horário) saem no outro arquivo, junto da grade que elas governam.
 */
function montarGeral(aulas, hoje, conhecidas) {
  const out = [];

  out.push('# Grade Horária — AP Academia');
  out.push('');
  out.push('> **Arquivo gerado automaticamente** a partir de `data/grade-aulas.csv`');
  out.push('> (exportação da grade do sistema). Não edite este `.md` à mão: atualize o');
  out.push('> CSV e rode `npm run grade`, senão a próxima geração desfaz a edição.');
  out.push('>');
  out.push('> **A grade da Escola de Natação Infantil e da Natação Bebê está em');
  out.push('> `grade-horaria-infantil.md`**, no módulo `infantil`. Aqui estão as');
  out.push('> atividades a partir de 13 anos e as regras gerais de leitura.');
  out.push(`> Última geração: ${hoje}.`);
  out.push('');
  out.push('## Como usar esta grade no atendimento');
  out.push('');
  out.push('1. O horário indicado é o **horário de início** da aula.');
  out.push('2. **"até N vagas" é a capacidade máxima do horário, NÃO a quantidade de');
  out.push('   vagas livres.** Nunca afirme que há vaga. Para confirmar vaga, use');
  out.push('   `transferir_para_humano`.');
  out.push('   Pelo mesmo motivo, **não existe aqui qual horário é mais cheio ou mais');
  out.push('   vazio**: esta grade não registra movimento nem ocupação. Nunca diga que');
  out.push('   um horário "é o pico", "costuma lotar" ou "é mais tranquilo" — isso é');
  out.push('   invenção, mesmo quando parece óbvio.');
  out.push('3. Se o cliente pedir um dia/horário que não está listado aqui, esse horário');
  out.push('   **não existe na grade** — diga isso e ofereça as opções próximas que existem.');
  out.push('4. Dois horários seguidos da mesma modalidade (ex.: 19:00 e 19:40) são turmas');
  out.push('   diferentes, não uma aula longa.');
  out.push('5. A grade pode mudar; ao fechar a matrícula, o horário é confirmado pelo consultor.');
  out.push('');
  out.push('**Duração das aulas adultas e coletivas: 45 minutos.** É dado confirmado —');
  out.push('responda direto, não transfira.');
  out.push('');
  out.push('## Aulas x funcionamento');
  out.push('');
  out.push('A academia abre **06:00–12:30 e 15:00–22:00** de segunda a sexta e');
  out.push('**08:30–13:00** no sábado; domingo não abre (`informacoes-gerais.md`).');
  out.push('A grade de aulas é mais estreita que o horário de funcionamento:');
  out.push('');
  out.push('- **Segunda a sexta:** primeira aula 06:00, última aula começa 21:00,');
  out.push('  e não há nenhuma aula entre 11:20 e 15:00.');
  out.push('- **Sábado:** primeira aula 08:40, última aula começa 12:20.');
  out.push('- **Domingo:** fechado.');
  out.push('');
  out.push('---');
  out.push('');
  out.push(...renderSecoes(aulas, 'geral', conhecidas));

  const musc = resumoMusculacao(aulas);
  out.push('## Musculação');
  out.push('');
  out.push('> Inclusa em todos os planos adulto. Cada sessão tem hora de início e um');
  out.push(`> limite de alunos — de ${musc.min} a ${musc.max}, conforme o horário. O diferencial de`);
  out.push('> a musculação ser por sessão agendada está em `atividades.md`; as regras de');
  out.push('> agendamento, em `operacional-adulto.md`.');
  out.push('');
  out.push('Sessões (início de cada uma):');
  out.push('');
  out.push(...musc.linhas);
  out.push('');

  return out;
}

/**
 * `grade-horaria-infantil.md` — módulo `infantil`.
 *
 * Carrega junto as regras de leitura que só fazem sentido com esta grade na
 * frente: o par de dias, o tamanho da turma pedagógica e o que fazer quando o
 * horário não lista os níveis que atende.
 */
function montarInfantil(aulas, hoje, conhecidas) {
  const out = [];

  out.push('# Grade Horária — Escola de Natação Infantil e Bebês');
  out.push('');
  out.push('> **Arquivo gerado automaticamente** a partir de `data/grade-aulas.csv`.');
  out.push('> Não edite este `.md` à mão: atualize o CSV e rode `npm run grade`.');
  out.push('>');
  out.push('> **Módulo `infantil`.** As atividades a partir de 13 anos e as regras');
  out.push('> gerais de leitura da grade estão em `grade-horaria.md`, que vai em toda');
  out.push('> conversa. O que está aqui vale por cima daquilo, não no lugar.');
  out.push(`> Última geração: ${hoje}.`);
  out.push('');
  out.push('## Como ler a grade infantil');
  out.push('');
  out.push('1. **"até N vagas" não é o tamanho da turma.** No mesmo horário a piscina');
  out.push('   recebe mais de uma turma, divididas por nível. Os tamanhos de turma');
  out.push('   (até 5 iniciantes de 3 a 5 anos, até 6 iniciantes de 6 a 12, até 10 nos');
  out.push('   demais níveis) estão em `base-conhecimento-natacao-infantil.md` —');
  out.push('   **use esses** ao falar de turma reduzida, nunca o número de vagas.');
  out.push('2. **Nunca ofereça um dia solto da semana:** a matrícula é o par de dias');
  out.push('   (regra na próxima seção).');
  out.push('3. **O nível NÃO restringe o horário. O que separa é o grupo etário.**');
  out.push('   São três grupos, e só eles: **bebê**, **3 a 5** e **6 a 12**. Dentro do');
  out.push('   grupo, **todo horário atende todos os níveis** — inclusive quando o nome');
  out.push('   da atividade cita um nível só ("Natação Infantil N1", "Golfinhos N3+").');
  out.push('   O nome é a referência da turma, não uma porta fechada.');
  out.push('');
  out.push('   Na prática: perguntaram os horários de uma criança de 8 anos no N5?');
  out.push('   Ofereça **todos** os horários de 6 a 12, não só os que dizem "N5+".');
  out.push('   Nunca diga que o nível da criança não é atendido num horário, e nunca');
  out.push('   transfira por causa disso. Quem confirma a turma e a vaga é o');
  out.push('   consultor, com o professor.');
  out.push('');
  out.push('**Duração:** bebê 30 minutos; 3–5 e 6–12 anos 45 minutos. É dado');
  out.push('confirmado — responda direto, não transfira.');
  out.push('');
  out.push('## Como funciona a matrícula da natação infantil');
  out.push('');
  out.push('Vale para toda a Escola de Natação Infantil (3 a 5 e 6 a 12 anos).');
  out.push('**Não vale para a Natação Bebê**, que é 1x na semana por turma.');
  out.push('');
  out.push('- A matrícula na semana é sempre um **par de dias no mesmo horário**:');
  out.push('  **Segunda + Quarta** ou **Terça + Quinta**. Não existe matrícula em um dia');
  out.push('  só, nem em dias cruzados (ex.: segunda e terça).');
  out.push('- As turmas de **sábado são exclusivas do sábado**: quem entra nelas faz');
  out.push('  1x na semana e não combina com os pares da semana.');
  out.push('- **Sexta não tem matrícula.** As turmas de sexta são usadas pelos alunos que');
  out.push('  têm direito a aula extra na semana.');
  out.push('- Ligação com a frequência do nível (`planos-e-valores.md`): o par de dias');
  out.push('  entrega as 2 sessões do nível iniciante. Os níveis intermediário (3) e de');
  out.push('  aperfeiçoamento (5) completam a frequência com as aulas extras a que o');
  out.push('  aluno passa a ter direito — o valor do plano é o mesmo nos três.');
  out.push('- Ao oferecer horário, apresente o par inteiro: *"tem turma terça e quinta');
  out.push('  às 17:00"*, nunca *"tem turma na terça às 17:00"*.');
  out.push('');
  out.push('---');
  out.push('');
  out.push(...renderSecoes(aulas, 'infantil', conhecidas));

  return out;
}

function gerar() {
  const aulas = lerCsv();
  const hoje = new Date().toLocaleDateString('pt-BR');
  const conhecidas = new Set([MUSCULACAO]);

  const geral = montarGeral(aulas, hoje, conhecidas);
  const infantil = montarInfantil(aulas, hoje, conhecidas);

  // Atividade nova no CSV que ninguém classificou vai para o arquivo do
  // núcleo de propósito: lá ela é vista em toda conversa, e o objetivo é
  // que alguém a classifique — não que ela fique escondida num módulo.
  const orfas = [...new Set(aulas.map((a) => a.atividade))].filter((a) => !conhecidas.has(a));
  if (orfas.length) {
    geral.push('## Atividades ainda não classificadas');
    geral.push('');
    geral.push('> Apareceram no CSV mas não estão em nenhuma seção acima. Classificar em');
    geral.push('> `scripts/gerar-grade-horaria.js`.');
    geral.push('');
    for (const atividade of orfas) {
      geral.push(`### ${atividade}`);
      geral.push('');
      geral.push(...linhasSoltas(aulas, atividade));
      geral.push('');
    }
  }

  geral.push('---');
  geral.push('');
  geral.push('## Pendências desta grade (não invente estes dados)');
  geral.push('');
  geral.push('- **Horário de feriados:** ver `informacoes-gerais.md`.');
  geral.push('- **Vagas livres por turma** não existem nesta base — só a lotação máxima.');
  geral.push('- **Musculação a partir de 11 anos** existe em horários específicos');
  geral.push('  (9h30–11h30 e 15h15–18h, conforme a base de natação infantil), mas a');
  geral.push('  exportação não marca quais sessões são essas.');
  geral.push('');

  writeFileSync(OUT_GERAL, geral.join('\n'), 'utf-8');
  writeFileSync(OUT_INFANTIL, infantil.join('\n'), 'utf-8');
  console.log(`grade-horaria.md: ${geral.length} linhas`);
  console.log(`grade-horaria-infantil.md: ${infantil.length} linhas`);
  console.log(`${aulas.length} aulas lidas do CSV`);
  for (const aviso of avisos) console.log(`atenção: ${aviso}`);
  if (orfas.length) console.log(`atenção: atividades não classificadas -> ${orfas.join(', ')}`);
}

gerar();
