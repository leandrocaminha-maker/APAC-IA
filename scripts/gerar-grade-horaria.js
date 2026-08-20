/**
 * Gera src/prompts/knowledge/grade-horaria.md a partir de data/grade-aulas.csv.
 *
 * O CSV é a exportação da grade do sistema (Hora;Dia;Atividade;Capacidade;Professor).
 * O .md é o que o agente de IA lê como base de conhecimento.
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
const OUT = join(ROOT, 'src', 'prompts', 'knowledge', 'grade-horaria.md');

const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
const DIA_LABEL = { Seg: 'Seg', Ter: 'Ter', Qua: 'Qua', Qui: 'Qui', Sex: 'Sex', Sab: 'Sáb' };

// Pares de matrícula da natação infantil, na ordem em que aparecem no arquivo.
const PARES = [['Seg', 'Qua'], ['Ter', 'Qui']];

const avisos = [];

// Agrupamento das atividades em seções, na ordem em que aparecem no arquivo.
// A ordem segue o funil de vendas: infantil primeiro, depois adulto.
// regime 'par' = natação infantil (matrícula em par de dias).
const SECOES = [
  {
    titulo: 'Escola de Natação Infantil — trilha 3 a 5 anos',
    regime: 'par',
    nota:
      'Níveis da trilha 3 a 5 anos, na ordem: Adaptação → Estrelinha N1 → ' +
      'Peixinho N2 → Golfinho I → Golfinho II → Jubarte. As turmas agrupam níveis ' +
      'vizinhos. O conteúdo de cada nível e a idade de entrada estão em ' +
      '`base-conhecimento-natacao-infantil.md`.',
    atividades: [
      ['Natação 3-5 Adaptação', 'quem nunca teve contato com a piscina'],
      ['Natação Peixinhos N1&N2', 'níveis Estrelinha N1 e Peixinho N2'],
      ['Natação Golfinhos N3+', 'níveis Golfinho I em diante'],
    ],
  },
  {
    titulo: 'Escola de Natação Infantil — trilha 6 a 12 anos',
    regime: 'par',
    nota:
      'Níveis da trilha 6 a 12 anos, na ordem: N1 Branca → N2 Branca → N3 e N4 ' +
      'Amarela → N5 e N6 Laranja → N7 e N8 Vermelha → Atleta. Turmas com dois ' +
      'níveis no nome (ex.: "N1 N2") atendem os dois.',
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
    nota:
      'De **12 meses até entre 3 anos e meio e 4 anos**, **1x na semana** — cada ' +
      'horário abaixo é uma turma independente. A regra de matrícula em par de dias ' +
      'da natação infantil **não vale aqui**.',
    atividades: [['Natação Bebê 1 e 2', null]],
  },
  {
    titulo: 'Natação Adulto',
    nota: 'A partir de 13 anos. Inclusa nos planos Estilo Aqua e Estilo de Vida Plus.',
    atividades: [['Natação Adulto', null]],
  },
  {
    titulo: 'Hidroginástica',
    nota: 'Inclusa nos planos Estilo Aqua e Estilo de Vida Plus.',
    atividades: [
      ['Hidroginástica', null],
      ['Hidro Zen & Meditação', null],
    ],
  },
  {
    titulo: 'Pilates Fit Studio',
    nota:
      'Estúdio com 8 lugares por sessão. Liberado no Estilo de Vida Plus; ' +
      'no Estilo Aqua são 8 sessões para vivenciar; não incluso no Performa.',
    atividades: [['Pilates Fit Studio', null]],
  },
  {
    titulo: 'Aulas coletivas (inclusas em todos os planos adulto)',
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
    nota:
      'Atividade terrestre infantil, 6 a 12 anos. Entra como combo da Escola de ' +
      'Natação (+R$ 27) ou como atividade avulsa (ver `planos-e-valores.md`).',
    atividades: [['Funcional Kids', null]],
  },
  {
    titulo: 'Avaliação e Consultoria',
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

  const out = [];
  if (semana.length) {
    out.push('Matrícula na semana (2x, sempre nos dois dias do par):');
    out.push(...semana);
  }
  if (sabado.length) {
    if (out.length) out.push('');
    out.push('Turma de sábado (1x na semana, exclusiva do dia):');
    out.push(...sabado);
  }
  if (sexta.length) {
    if (out.length) out.push('');
    out.push('Sexta — aula extra, **não é turma de matrícula**:');
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

function gerar() {
  const aulas = lerCsv();
  const hoje = new Date().toLocaleDateString('pt-BR');
  const conhecidas = new Set([MUSCULACAO]);
  const out = [];

  out.push('# Grade Horária — AP Academia');
  out.push('');
  out.push('> **Arquivo gerado automaticamente** a partir de `data/grade-aulas.csv`');
  out.push('> (exportação da grade do sistema). Não edite este `.md` à mão: atualize o');
  out.push('> CSV e rode `npm run grade`, senão a próxima geração desfaz a edição.');
  out.push(`> Última geração: ${hoje}.`);
  out.push('');
  out.push('## Como usar esta grade no atendimento');
  out.push('');
  out.push('1. O horário indicado é o **horário de início** da aula.');
  out.push('2. **"até N vagas" é a capacidade máxima do horário, NÃO a quantidade de');
  out.push('   vagas livres.** Nunca afirme que há vaga. Para confirmar vaga, use');
  out.push('   `transferir_para_humano`.');
  out.push('3. **Esse número também não é o tamanho da turma.** No mesmo horário a');
  out.push('   piscina recebe mais de uma turma, divididas por nível. Os tamanhos de');
  out.push('   turma da natação infantil (até 5 iniciantes de 3 a 5 anos, até 6');
  out.push('   iniciantes de 6 a 12, até 10 nos demais níveis) estão em');
  out.push('   `base-conhecimento-natacao-infantil.md` — **use esses** ao falar de');
  out.push('   turma reduzida, nunca o número de vagas do horário.');
  out.push('4. Se o cliente pedir um dia/horário que não está listado aqui, esse horário');
  out.push('   **não existe na grade** — diga isso e ofereça as opções próximas que existem.');
  out.push('5. Na natação infantil, **nunca ofereça um dia solto da semana**: a matrícula');
  out.push('   é o par (ver a regra na próxima seção).');
  out.push('6. Dois horários seguidos da mesma modalidade (ex.: 19:00 e 19:40) são turmas');
  out.push('   diferentes, não uma aula longa.');
  out.push('7. **Nem todo horário infantil lista os níveis que atende.** Quando o horário');
  out.push('   não especificar os níveis, assuma que **todos os níveis daquele grupo');
  out.push('   etário estão inclusos** — não diga que o nível da criança não é atendido');
  out.push('   ali, e não transfira por causa disso. A confirmação do nível na turma é');
  out.push('   do consultor, junto com a vaga.');
  out.push('8. A grade pode mudar; ao fechar a matrícula, o horário é confirmado pelo consultor.');
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

  for (const secao of SECOES) {
    out.push(`## ${secao.titulo}`);
    out.push('');
    if (secao.nota) {
      out.push(`> ${secao.nota}`);
      out.push('');
    }
    for (const [atividade, descricao] of secao.atividades) {
      conhecidas.add(atividade);
      const linhas = secao.regime === 'par'
        ? linhasEmPares(aulas, atividade)
        : linhasSoltas(aulas, atividade);
      if (!linhas.length) continue;
      out.push(descricao ? `### ${atividade} — ${descricao}` : `### ${atividade}`);
      out.push('');
      out.push(...linhas);
      out.push('');
    }
  }

  const musc = resumoMusculacao(aulas);
  out.push('## Musculação');
  out.push('');
  out.push('> Inclusa em todos os planos adulto.');
  out.push('');
  out.push('**A musculação aqui é por sessão agendada, e isso é um diferencial —');
  out.push('use na conversa.** Não é o modelo da maioria das academias, onde o aluno');
  out.push('entra a qualquer momento e a sala lota. Aqui cada sessão tem hora de início');
  out.push(`e um limite de alunos (de ${musc.min} a ${musc.max}, conforme o horário), então o aluno`);
  out.push('sempre treina com relação aluno/professor confortável — que é o que permite o');
  out.push('acompanhamento técnico incluso no plano (ver `planos-e-valores.md`).');
  out.push('O agendamento é feito no app FITI, sem limite de sessões por dia. O aluno');
  out.push('mantém até 3 agendamentos pendentes ao mesmo tempo, no máximo 1 por');
  out.push('modalidade — ver `operacional-adulto.md` e `suporte-fiti.md`.');
  out.push('');
  out.push('Sessões (início de cada uma):');
  out.push('');
  out.push(...musc.linhas);
  out.push('');

  const orfas = [...new Set(aulas.map((a) => a.atividade))].filter((a) => !conhecidas.has(a));
  if (orfas.length) {
    out.push('## Atividades ainda não classificadas');
    out.push('');
    out.push('> Apareceram no CSV mas não estão em nenhuma seção acima. Classificar em');
    out.push('> `scripts/gerar-grade-horaria.js`.');
    out.push('');
    for (const atividade of orfas) {
      out.push(`### ${atividade}`);
      out.push('');
      out.push(...linhasSoltas(aulas, atividade));
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('## Duração das aulas');
  out.push('');
  out.push('- **Adultas e coletivas:** 45 minutos (`atividades.md`).');
  out.push('- **Infantis:** bebê 30 minutos; 3–5 e 6–12 anos 45 minutos');
  out.push('  (`base-conhecimento-natacao-infantil.md`).');
  out.push('');
  out.push('Isto é dado confirmado — responda direto, não transfira.');
  out.push('');
  out.push('---');
  out.push('');
  out.push('## Pendências desta grade (não invente estes dados)');
  out.push('');
  out.push('- **Horário de feriados:** ver `informacoes-gerais.md`.');
  out.push('- **Vagas livres por turma** não existem nesta base — só a lotação máxima.');
  out.push('- **Musculação a partir de 11 anos** existe em horários específicos');
  out.push('  (9h30–11h30 e 15h15–18h, conforme a base de natação infantil), mas a');
  out.push('  exportação não marca quais sessões são essas.');
  out.push('');

  writeFileSync(OUT, out.join('\n'), 'utf-8');
  console.log(`grade-horaria.md gerado: ${aulas.length} aulas, ${out.length} linhas`);
  for (const aviso of avisos) console.log(`atenção: ${aviso}`);
  if (orfas.length) console.log(`atenção: atividades não classificadas -> ${orfas.join(', ')}`);
}

gerar();
