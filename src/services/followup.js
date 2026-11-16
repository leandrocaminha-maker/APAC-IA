/**
 * src/services/followup.js
 * Follow-up de venda: agendar, cancelar e decidir a próxima rodada.
 *
 * O que este módulo NÃO faz é escrever a mensagem — isso é do worker, no
 * momento do envio. A razão está na régua: o follow-up de depois da aula
 * precisa saber se a pessoa **compareceu**, e isso só se sabe depois da
 * aula. Guardar a frase pronta no agendamento produziria "como foi a
 * aula?" para quem faltou, que é pior do que não mandar nada.
 */
import { config } from '../config.js';
import { supabase, lerTodas } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import {
  registrarEvento, definirTipoDeContato, tocarAtividade, mudarEtapa, FILTRO_ETAPAS_FECHADAS,
} from './funil.js';
// Sem ciclo: `evolution.js` só importa config e logger, e `contacts.js` só
// o banco e o `evolution.js`.
import { telefoneValido } from './evolution.js';
import { handoffToHuman } from './contacts.js';
import { temAulaPorVir } from './aula-regras.js';
import { evoClient } from './evo-client.js';
import { ehFeriado } from '../lib/feriados.js';

/**
 * Janela de contato ativo, em horário de São Paulo.
 *
 * Vale para toda mensagem que **parte** da academia. Responder quem
 * escreveu é outra coisa e vale a qualquer hora.
 *
 *   segunda a sexta   9h00 – 20h30
 *   sábado            9h00 – 13h00
 *   domingo           sem contato
 *   feriado           sem contato (`lib/feriados.js`)
 *
 * Domingo era dia normal até 28/08/2026, com a justificativa de que "mandar
 * WhatsApp no domingo de manhã não incomoda ninguém". A regra da academia é
 * outra: domingo não se aborda. Sábado à tarde também não — a janela fecha
 * junto com a recepção, e mensagem que a pessoa responde às 16h de sábado
 * não tem quem atenda.
 */
const SEMANA = { inicioMin: 9 * 60, fimMin: 20 * 60 + 30 };
const SABADO = { inicioMin: 9 * 60, fimMin: 13 * 60 };

/** Indexado pelo dia da semana do `Date` (0 = domingo). `null` = sem contato. */
export const JANELAS = [null, SEMANA, SEMANA, SEMANA, SEMANA, SEMANA, SABADO];

/**
 * Mantida por compatibilidade: é a janela de dia útil.
 *
 * Quem precisa decidir se PODE falar agora deve usar `janelaDoDia`, que
 * sabe do sábado e do domingo. Esta constante só descreve o dia comum.
 */
export const JANELA = SEMANA;

// O Brasil aboliu o horário de verão em 2019, então São Paulo é UTC-3 o
// ano todo. Se algum dia voltar, esta constante vira uma conversão por
// Intl — e é por isso que ela está isolada aqui.
const OFFSET_SP_MS = -3 * 60 * 60 * 1000;

/** Partes locais de São Paulo (ano, mês, dia, hora, minuto) de um Date. */
function partesSP(data) {
  const deslocado = new Date(data.getTime() + OFFSET_SP_MS);
  return {
    ano: deslocado.getUTCFullYear(),
    mes: deslocado.getUTCMonth(),
    dia: deslocado.getUTCDate(),
    hora: deslocado.getUTCHours(),
    minuto: deslocado.getUTCMinutes(),
    diaSemana: deslocado.getUTCDay(),   // 0 = domingo
  };
}

/** Monta um Date a partir de uma hora local de São Paulo. */
function deSP({ ano, mes, dia, hora, minuto = 0 }) {
  return new Date(Date.UTC(ano, mes, dia, hora, minuto) - OFFSET_SP_MS);
}

/**
 * A janela de contato do dia (de São Paulo) `p`, ou `null` sem contato.
 *
 * Feriado não tem contato (01/11/2026): a academia não abre, e 02/11 teria
 * saído como uma segunda qualquer. A lista está em `lib/feriados.js`.
 */
function janelaDasPartes(p) {
  const janela = JANELAS[p.diaSemana];
  if (!janela) return null;
  return ehFeriado(deSP({ ...p, hora: 12, minuto: 0 })) ? null : janela;
}

/** As partes de São Paulo do dia `i` dias depois de `p` (negativo = antes). */
function diaDeslocado(p, i) {
  return partesSP(deSP({ ...p, dia: p.dia + i, hora: 12, minuto: 0 }));
}

/** A janela de contato do dia em que `data` cai, ou `null` se for domingo ou feriado. */
export function janelaDoDia(data) {
  return janelaDasPartes(partesSP(data));
}

/**
 * Abertura do primeiro dia com contato a partir de `desloc` dias adiante.
 *
 * O laço vai até 31: o recesso de fim de ano (21/12 a 03/01) fecha 14
 * dias seguidos, e sábado à tarde antes dele precisa de 16 passos.
 */
function proximaAbertura(p, desloc = 1) {
  for (let i = desloc; i < desloc + 31; i++) {
    const d = diaDeslocado(p, i);
    const janela = janelaDasPartes(d);
    if (janela) return deSP({ ...d, hora: 0, minuto: janela.inicioMin });
  }
  return deSP({ ...p, dia: p.dia + desloc, hora: 9, minuto: 0 });   // inalcançável
}

/**
 * Empurra um horário para dentro da janela de contato ativo.
 *
 * Antes de abrir, num dia que abre → a abertura do mesmo dia. Fechado, ou
 * já encerrado → a abertura do próximo dia com contato, o que faz sábado à
 * tarde saltar o domingo inteiro e cair na segunda.
 *
 * `hora: 0, minuto: <minutos do dia>` não é gambiarra: `Date.UTC` normaliza
 * o excesso, então 570 minutos viram 9h30 e o dia 32 vira o dia 1º do mês
 * seguinte. É o que dispensa aritmética de calendário aqui.
 */
export function dentroDaJanela(data) {
  const p = partesSP(data);
  const minutos = p.hora * 60 + p.minuto;
  const hoje = janelaDasPartes(p);

  if (hoje && minutos >= hoje.inicioMin && minutos <= hoje.fimMin) return data;
  if (hoje && minutos < hoje.inicioMin) {
    return deSP({ ...p, hora: 0, minuto: hoje.inicioMin });
  }
  return proximaAbertura(p);
}

/**
 * `data` cai dentro da janela de contato ativo?
 *
 * É a pergunta da hora do ENVIO, não do agendamento. Agendar dentro da
 * janela não bastava: o que sobrava do dia — o teto do número estoura toda
 * segunda — ficava vencido, o teto zerava à meia-noite, e o worker mandava
 * tudo entre 0h e 0h20. Foram 149 mensagens fora do horário entre 15/09 e
 * 28/10/2026 (a Duda recebeu o encerramento às 0h07).
 */
export function estaNaJanela(data = new Date()) {
  return dentroDaJanela(data).getTime() === data.getTime();
}

/**
 * Antecedência mínima que faz um lembrete valer a pena.
 *
 * Seis horas é o que reproduz a regra da academia — "aula de segunda a
 * partir das 15h, aviso na segunda de manhã" — sem precisar escrever as
 * 15h em lugar nenhum: o dia abre às 9h, e 9h + 6h = 15h. Escrito como
 * antecedência em vez de hora de corte, a regra continua valendo se a
 * janela de abertura mudar, e passa a cobrir sozinha casos que a hora de
 * corte não cobria — aula de domingo à tarde, entre eles.
 */
const LEMBRETE_ANTECEDENCIA_MIN_MS = 6 * 60 * 60 * 1000;

/**
 * Quando mandar o lembrete de uma aula experimental.
 *
 * O padrão é 24h antes. O caso que quebra é a aula de segunda: 24h antes é
 * domingo, e domingo não tem contato. Empurrar para a frente resolveria no
 * papel e falharia na prática — para a aula de segunda às 9h, a "próxima
 * abertura" é segunda às 9h, quando a pessoa já deveria estar lá.
 *
 * Então a decisão não é "o ideal caiu em dia sem contato?", e sim **"o
 * horário ajustado ainda avisa a tempo?"**:
 *
 *  - **Sim** → usa o ajuste normal. Aula de segunda às 15h vira aviso na
 *    segunda de manhã, com seis horas de folga.
 *  - **Não** → recua para o último dia com contato antes do ideal, na
 *    mesma hora, presa à janela daquele dia. Aula de segunda cedo vira
 *    aviso no sábado: 48h de antecedência em vez de 24, pior do que o
 *    ideal e muito melhor do que um aviso que chega junto com a aula.
 *
 * A primeira versão perguntava pelo dia sem contato e deixava passar a
 * aula de domingo à tarde — o ideal caía no sábado, que TEM janela, mas
 * fora dela, e o ajuste jogava o lembrete para a segunda, depois da aula.
 * Perguntar pela antecedência fecha os dois casos com uma regra só.
 *
 * `antecedenciaMinMs` troca as seis horas por outra antecedência, que passa
 * a valer também no recuo. É o lembrete da véspera da avaliação física: ele
 * diz até quando se desmarca sem taxa (12 h antes), e chegar depois disso
 * seria avisar de um prazo vencido.
 */
export function horarioDoLembrete(aula, { antecedenciaMinMs } = {}) {
  const ideal = new Date(aula.getTime() - 24 * 60 * 60 * 1000);
  const candidato = dentroDaJanela(ideal);
  const antecedencia = antecedenciaMinMs ?? LEMBRETE_ANTECEDENCIA_MIN_MS;
  // Sem antecedência própria, o recuo só pede que o aviso venha antes da
  // aula — como sempre foi. Com ela, o recuo também a respeita.
  const limiteDoRecuo = aula.getTime() - (antecedenciaMinMs ?? 0);

  if (candidato.getTime() <= aula.getTime() - antecedencia) {
    return candidato;
  }

  // O laço começa no próprio dia do ideal (i = 0), e não no anterior: para
  // a aula de domingo à tarde, o ideal é sábado à tarde — o dia certo, só
  // que fora da janela. Prender às 13h resolve sem sair do sábado.
  const pi = partesSP(ideal);
  const minutosIdeal = pi.hora * 60 + pi.minuto;

  for (let i = 0; i <= 31; i++) {
    const d = diaDeslocado(pi, -i);
    const janela = janelaDasPartes(d);
    if (!janela) continue;
    const minuto = Math.min(Math.max(minutosIdeal, janela.inicioMin), janela.fimMin);
    const recuado = deSP({ ...d, hora: 0, minuto });
    if (antecedenciaMinMs === undefined ? recuado.getTime() < aula.getTime() : recuado.getTime() <= limiteDoRecuo) {
      return recuado;
    }
  }
  return candidato;   // inalcançável com JANELAS de um dia fechado só
}

/**
 * Folga máxima, em minutos, de quem foi empurrado para a abertura da janela.
 *
 * Cabe dentro da menor janela que temos (sábado, 9h–13h) com sobra larga.
 */
const FOLGA_NA_ABERTURA_MIN = 45;

/**
 * Espalha quem caiu na abertura da janela.
 *
 * `dentroDaJanela` devolve o minuto EXATO da abertura — 9h00:00 — para
 * tudo que venceu fora dela. Agendamento da noite, do domingo e da tarde
 * de sábado aterrissavam todos no mesmo segundo, e o worker mandava o
 * monte inteiro de uma vez. Era a rajada diária das 9h que a Meta viu em
 * 31/08/2026.
 *
 * A folga só entra quando o horário FOI movido. Quem já estava dentro da
 * janela é respeitado: a varredura de silêncio calcula o espaçamento dela
 * própria, e embaralhar isso aqui desfaria o trabalho dela.
 */
function comFolgaNaAbertura(pedido) {
  const alvo = dentroDaJanela(pedido);
  if (alvo.getTime() === pedido.getTime()) return alvo;
  return new Date(alvo.getTime() + Math.floor(Math.random() * FOLGA_NA_ABERTURA_MIN * 60_000));
}

/**
 * Agenda um follow-up.
 *
 * Idempotente pela UNIQUE parcial `(lead_id, tipo) WHERE pendente`: chamar
 * duas vezes não gera duas cobranças. Reagendamento explícito atualiza a
 * data em vez de duplicar.
 */
export async function agendar(leadId, tipo, quando, contexto = {}) {
  const alvo = comFolgaNaAbertura(quando instanceof Date ? quando : new Date(quando));

  const { data, error } = await supabase
    .from('crm_followups')
    .insert({
      lead_id: leadId,
      tipo,
      scheduled_for: alvo.toISOString(),
      contexto,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      // Já existe um pendente deste tipo: atualiza a data.
      const { data: atualizado } = await supabase
        .from('crm_followups')
        .update({ scheduled_for: alvo.toISOString(), contexto })
        .eq('lead_id', leadId)
        .eq('tipo', tipo)
        .eq('status', 'pendente')
        .select()
        .single();

      logger.info(`[followup] Lead ${leadId}: ${tipo} reagendado para ${alvo.toISOString()}`);
      return atualizado;
    }
    logger.error(`[followup] Falha ao agendar ${tipo}:`, error.message);
    return null;
  }

  logger.info(`[followup] Lead ${leadId}: ${tipo} agendado para ${alvo.toISOString()}`);
  return data;
}

/** Cancela follow-ups pendentes de um lead. `tipos` vazio = todos. */
export async function cancelar(leadId, tipos = [], motivo = 'cancelado') {
  let q = supabase
    .from('crm_followups')
    .update({ status: 'cancelado', erro: motivo })
    .eq('lead_id', leadId)
    .eq('status', 'pendente');

  if (tipos.length) q = q.in('tipo', tipos);

  const { data, error } = await q.select('id, tipo');
  if (error) {
    logger.error('[followup] Falha ao cancelar:', error.message);
    return 0;
  }

  if (data?.length) {
    logger.info(`[followup] Lead ${leadId}: ${data.length} follow-up(s) cancelado(s) — ${motivo}`);
  }
  return data?.length || 0;
}

/** Hora da conversa pós-aula: a manhã seguinte, depois do aviso do EVO. */
const HORA_POS_AULA = 10;

/**
 * Quando sai a conversa de depois da aula experimental.
 *
 * Na manhã seguinte, às 10h, e não mais quatro horas depois. A presença
 * vem da automação do CRM do EVO ("aula experimental realizada"), que roda
 * de madrugada — as do CRM chegam todas por volta das 5h. Até 26/10/2026 o
 * sistema perguntava ao EVO pela sessão até quatro vezes por aula; pedido
 * do responsável, a consulta saiu.
 *
 * Dia sem contato (domingo) empurra para a próxima abertura.
 */
export function horarioDoPosAula(aula) {
  const p = partesSP(aula);
  return dentroDaJanela(deSP({ ano: p.ano, mes: p.mes, dia: p.dia + 1, hora: HORA_POS_AULA }));
}

/**
 * Chamado quando a aula experimental é agendada.
 *
 * Dois follow-ups nascem juntos porque nascem do mesmo fato:
 *
 *  - **24h antes**: confirmar presença e reforçar o valor de ir. É o
 *    momento em que a pessoa decide se vai mesmo, e um lembrete muda essa
 *    taxa mais do que qualquer argumento depois.
 *  - **na manhã seguinte** (`horarioDoPosAula`): conversar de acordo com a
 *    presença que o EVO avisou durante a madrugada.
 */
/**
 * O lembrete da aula vale a pena? `lembrete` é o horário já ajustado
 * (`horarioDoLembrete`), `aula` o da aula, e `agora` a hora em que ela foi
 * marcada.
 *
 *  - Perto demais (menos de 30 min): chegaria depois da aula, ou junto com
 *    a confirmação que a pessoa acabou de receber. A conta é sobre o horário
 *    ajustado, porque é ele que sai — o recuo para sábado pode deixá-lo no
 *    passado quando a aula de segunda é marcada no próprio domingo.
 *  - Lembrete no mesmo dia da marcação: a confirmação acabou de sair, e
 *    "lembrar" horas depois é repetir. Vale para a aula de hoje e para a
 *    de amanhã cujo lembrete cairia ainda hoje. Decisão do responsável em
 *    10/11/2026, pelo caso da Joyce: a Leia marcou às 7h25 o Boxe Fitness
 *    das 19h15, e o lembrete saiu às 9h08, na abertura da janela. Outros
 *    cinco tinham saído assim para aula do dia seguinte (marcada às 14h38,
 *    lembrete às 19h45 do mesmo dia).
 */
export function lembreteNecessario(lembrete, agora = new Date()) {
  if (!(lembrete.getTime() > agora.getTime() + 30 * 60 * 1000)) return false;
  const l = partesSP(lembrete);
  const a = partesSP(agora);
  return !(l.ano === a.ano && l.mes === a.mes && l.dia === a.dia);
}

export async function aoAgendarExperimental(lead, { dataHora, atividade }) {
  const aula = new Date(String(dataHora).replace(' ', 'T') + ':00-03:00');
  if (Number.isNaN(aula.getTime())) return;

  const contexto = { aula: aula.toISOString(), atividade: atividade || null };

  // Aula nova: a régua da anterior sai. Sem isto, o lembrete da aula velha
  // seguia pendente quando a nova não ganhava lembrete, e a sondagem de
  // "o que falta decidir" saía com outra aula marcada.
  await cancelar(lead.id, ['ae_lembrete_24h', 'ae_pos_aula', 'sondagem_1', 'sondagem_2'], 'aula nova marcada');

  // 24h antes, exceto quando isso cai em domingo — ver `horarioDoLembrete`.
  const lembrete = horarioDoLembrete(aula);

  if (lembreteNecessario(lembrete)) {
    await agendar(lead.id, 'ae_lembrete_24h', lembrete, contexto);
  } else {
    logger.info(`[followup] Lead ${lead.id}: lembrete cairia no dia da marcação (ou perto demais da aula) — sem lembrete`);
  }

  await agendar(lead.id, 'ae_pos_aula', horarioDoPosAula(aula), contexto);
}

// ──────────────────────────────────────────────
// Régua do silêncio: o lead que parou de responder
//
// A régua da aula acima só existe para quem marcou experimental. Quem
// sumiu no meio da conversa — depois de ouvir o preço, depois de dizer "vou
// ver e te falo" — não tinha nenhum turno em que alguém agisse. Esta seção
// é esse turno.
//
// ## A regra, desde 16/11/2026 (decisão do responsável)
//
// UMA retomada por silêncio, e dentro de 24 h da última mensagem do
// cliente. Sem resposta no dia, a conversa vai para o consultor, que decide
// se liga, escreve ou encerra. A Leia não escreve de novo.
//
// Até aqui eram duas rodadas, com 2 e 4 dias de silêncio, e depois o lead
// era dado como perdido. Medido em 45 dias (646 follow-ups): a primeira
// cutucada teve 39% de resposta em 72 h e a segunda 15%; as segundas
// tentativas eram 41% do volume da régua e traziam 19% das respostas. E
// toda cutucada saía com mais de 24 h de silêncio — conversa reaberta por
// nós, que é o que a Meta conta. Em 16/11 o número foi restringido pela
// segunda vez em três dias, num dia com 27 cutucadas de silêncio.
//
// ## Os dois relógios
//
// O silêncio é a NOSSA última fala sem resposta (`estadoDoSilencio`). As
// 24 h contam da última mensagem DELA: é o que mantém a retomada dentro da
// conversa que a própria pessoa abriu.
//
// ## Depois da aula
//
// É a mesma regra. A conversa de depois da aula (`ae_pos_aula`) já é a
// mensagem da Leia: sem resposta no dia, consultor. Quem respondeu a ela e
// parou depois recebe a retomada única, com o roteiro de quem já fez a
// aula (`sondagem_1`).
// ──────────────────────────────────────────────

const DIA_MS = 24 * 60 * 60 * 1000;
const HORA_MS = 60 * 60 * 1000;

export const TIPOS_SILENCIO = ['silencio_1', 'silencio_2'];
const TIPOS_SONDAGEM = ['sondagem_1', 'sondagem_2'];

/** A retomada única: uma por silêncio. O roteiro muda com quem já fez a aula. */
export const TIPOS_RETOMADA = ['silencio_1', 'sondagem_1'];

/**
 * A segunda tentativa, que não sai mais desde 16/11/2026. Os nomes ficam
 * porque há linhas gravadas com eles: as já enviadas ainda fecham o lead
 * pela regra antiga (`encerrarSemResposta`), e as pendentes são canceladas.
 */
export const TIPOS_SEGUNDA_RODADA = ['silencio_2', 'sondagem_2'];

/**
 * O que significa "este lead está na mão da Leia agora".
 *
 * São as mensagens que ELA escreve por conta própria, sem o cliente ter
 * falado: a primeira depois da aula experimental, e as duas rodadas de
 * quem parou de responder. Fora da lista fica `ae_lembrete_24h`, que é
 * recado de agenda — a aula é amanhã, e não há retomada nenhuma em curso.
 *
 * Serve ao filtro do painel. O consultor precisa saber em quem a Leia já
 * está mexendo, para não escrever por cima nem cobrar duas vezes.
 */
export const TIPOS_REGUA = ['ae_pos_aula', ...TIPOS_SONDAGEM, ...TIPOS_SILENCIO];

/**
 * Uma mensagem de saída que faz o relógio do silêncio começar a contar.
 *
 * Vale a fala da Leia (`bot`, `bot:followup`) e a do consultor
 * (`human:email`). **Não** vale:
 *
 *  - `app:*` — cobrança, nota fiscal, e também a campanha, que sai como
 *    `app:campanha:<slug>`. Quem não respondeu a um boleto não é um lead em
 *    silêncio, e quem não respondeu à abertura de campanha tem a porta de
 *    consentimento dela, não esta. Tratar isso como silêncio transformaria
 *    a régua numa segunda campanha, para uma lista fria.
 *  - `simulador` / `teste-web` — conversa de teste não recebe follow-up.
 *  - `bot:briefing` — o encaminhamento do acompanhamento ao professor. Se
 *    o professor já foi lead, o briefing sem resposta não é silêncio de venda.
 *  - `bot:acompanhamento` (e a Leia dele) — mensagem ao aluno do programa:
 *    aluno que não respondeu ao acompanhamento não é lead em silêncio.
 *  - `bot:ponte` — o repasse ao professor e o aviso de espera ao aluno, na
 *    ponte do acompanhamento (A5d). `professor:<id>` nem chega aqui como
 *    nossa fala: não começa com `bot` nem com `human:`, de propósito.
 */
function ehNossaFala(sentBy) {
  const quem = String(sentBy || '');
  // `bot:gerencia` é o aviso do painel gerencial à equipe — não é conversa de venda.
  if (quem === 'bot:briefing' || quem === 'bot:ponte' || quem === 'bot:gerencia'
    || quem.startsWith('bot:acompanhamento')) return false;
  return quem === 'bot' || quem.startsWith('bot:') || quem.startsWith('human:');
}

/**
 * Há quanto tempo este contato está sem responder à nossa última fala.
 *
 * Devolve `null` quando não está em silêncio — inclusive quando a última
 * palavra é dela (aí quem deve resposta somos nós, e follow-up seria
 * atropelo).
 *
 * Lê as 20 últimas mensagens em vez de duas consultas: uma sequência de
 * cobranças automáticas pode empurrar a nossa última fala real para trás, e
 * é ela que conta.
 */
export async function estadoDoSilencio(contactId) {
  const { data, error } = await supabase
    .from('wa_messages')
    .select('direction, sent_by, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data?.length) return null;

  const ultimaNossa = data.find(m => m.direction === 'outbound' && ehNossaFala(m.sent_by));
  if (!ultimaNossa) return null;

  const ultimaDela = data.find(m => m.direction === 'inbound');
  if (ultimaDela && new Date(ultimaDela.created_at) >= new Date(ultimaNossa.created_at)) {
    return null;
  }

  return {
    desde: new Date(ultimaNossa.created_at),
    porQuem: ultimaNossa.sent_by,
    dias: Math.floor((Date.now() - new Date(ultimaNossa.created_at).getTime()) / DIA_MS),
    // A última mensagem dela: é de onde contam as 24 h da retomada, e o que
    // separa um silêncio do outro (ver `decisaoDoSilencio`). Fora das 20
    // últimas mensagens conta como nunca: é quem não responde há muito tempo.
    respondeuEm: ultimaDela ? new Date(ultimaDela.created_at) : null,
  };
}

/**
 * Este "lead" é, na verdade, um aluno com contrato em dia?
 *
 * ## Por que a pergunta precisa ser feita
 *
 * `garantirLeadDoContato` abre um lead para **todo** contato que escreve no
 * WhatsApp, e o número é o principal da academia. Aluno matriculado
 * perguntando o horário da natação vira lead em `em_conversa` exatamente
 * como quem nunca pisou aqui. Se ele não responder à última mensagem, a
 * régua do silêncio o cutuca com "o que falta para você decidir?" — para
 * quem já decidiu, já pagou e está treinando.
 *
 * ## Por que não dá para usar `is_prospect`
 *
 * Porque ele não significa nada: nasce `true` em `contacts.js` e em
 * `teste.js`, e **nenhum código o coloca em false**. O mesmo vale para
 * `wa_contacts.evo_member_id`. Isso já estava documentado em `ai-agent.js`,
 * onde a conclusão foi não afirmar nada ao agente — aqui a conclusão é
 * outra, porque aqui dá para perguntar ao EVO.
 *
 * ## O que conta como aluno
 *
 * Só quem tem contrato ATIVO. Ex-aluno parado há mais de
 * `EVO_MESES_REATIVACAO` (3) é oportunidade, não cliente — é a mesma regra
 * que `situacaoDoMembro` já aplica para liberar aula experimental, e usar
 * outra aqui criaria duas definições de "aluno" no mesmo sistema.
 *
 * ## Falha fechada
 *
 * EVO fora do ar devolve `indefinido`, e o chamador **não** envia. É a
 * escolha certa entre os dois erros possíveis: adiar a cutucada de um lead
 * custa uma hora, porque a varredura repete; cutucar um aluno pagante custa
 * a relação com ele.
 *
 * @returns {Promise<'lead'|'aluno'|'indefinido'>}
 */
export async function situacaoComercial(lead) {
  try {
    let idMember = lead.evo_id_member || null;

    // Sem vínculo gravado, procura pelo telefone: o `evo_id_member` do lead
    // só é preenchido quando a tool de identificação da Leia rodou, e ela
    // não roda em toda conversa.
    if (!idMember) {
      const { cellphone } = evoClient.separarDdi(lead.phone);
      const membros = await evoClient.buscarMembros({ phone: cellphone, take: 5 });
      if (!membros?.length) return 'lead';       // não há cadastro de aluno
      idMember = membros[0].idMember;
    }

    const situacao = await evoClient.situacaoDoMembro(idMember);
    return situacao.reativavel ? 'lead' : 'aluno';
  } catch (err) {
    logger.warn(`[followup] Lead ${lead.id}: não deu para consultar o EVO (${err.message})`);
    return 'indefinido';
  }
}

/**
 * Teto de retomadas por lead, na vida inteira dele.
 *
 * Cada silêncio novo (a pessoa respondeu e sumiu de novo) abre direito a uma
 * retomada, e sem teto isso viraria uma cutucada a cada sumiço, para sempre.
 * Passado o teto, o silêncio vai direto para o consultor.
 */
export const TETO_RETOMADAS = 4;

// Folga de quem foi empurrado para a abertura da janela, e de quem foi
// recuado para o fim dela. Curta: a retomada tem prazo.
const FOLGA_ABERTURA_RETOMADA_MIN = 20;
const FOLGA_FECHAMENTO_RETOMADA_MIN = [10, 40];

/** A abertura do primeiro dia com contato DEPOIS do dia de `data`. */
export function aberturaSeguinte(data) {
  return proximaAbertura(partesSP(new Date(data)), 1);
}

/** O último fechamento da janela de contato em `data` ou antes dela. */
function fechamentoAnterior(data) {
  const p = partesSP(data);
  for (let i = 0; i <= 31; i++) {
    const d = diaDeslocado(p, -i);
    const janela = janelaDasPartes(d);
    if (!janela) continue;
    const fim = deSP({ ...d, hora: 0, minuto: janela.fimMin });
    if (fim.getTime() <= data.getTime()) return fim;
  }
  return null;
}

/**
 * O dia de `desde` já passou? Isto é: a janela de contato do dia seguinte
 * abriu, e está aberta agora.
 *
 * É o "sem resposta no dia" da regra: a mensagem de terça às 16h dá à
 * pessoa a noite de terça, e o repasse sai na quarta a partir das 9h. Só
 * dentro da janela porque o repasse cala a Leia, e de madrugada não há
 * consultor para atender quem escrever.
 */
export function diaPassou(desde, agora = new Date()) {
  return estaNaJanela(agora) && agora.getTime() >= aberturaSeguinte(desde).getTime();
}

/**
 * A que horas sai a retomada de quem escreveu por último em `ultimaDela`.
 *
 * Tem de cair dentro da janela de contato e antes de `limiteHoras` da
 * mensagem dela — o envio de verdade ainda leva o ciclo do worker, a pista e
 * o "digitando", e o prazo que não se passa é o de 24 h.
 *
 * Em ordem de preferência:
 *
 *  1. o alvo (`alvoHoras` depois; quem escreveu às 15h recebe às 12h do dia
 *     seguinte), ou agora mesmo, se o alvo já passou;
 *  2. a abertura seguinte, quando ainda cabe no prazo (escreveu às 11h, o
 *     alvo cai às 8h: sai às 9h);
 *  3. o fim da janela anterior, desde que tenham passado `minimoHoras`
 *     (escreveu às 9h30, o dia seguinte já estoura as 24 h: sai no fim da
 *     tarde do mesmo dia).
 *
 * Sem nenhuma das três — sábado ao meio-dia, véspera de feriado — devolve
 * `null`: não há retomada, e o silêncio vai para o consultor.
 *
 * @param {string|Date} ultimaDela
 * @param {object} [o]
 * @param {Date} [o.agora]
 * @param {{alvoHoras: number, limiteHoras: number, minimoHoras: number}} [o.cfg]
 * @param {() => number} [o.sorteio] - Para a folga; fixo nos testes.
 * @returns {Date|null}
 */
export function horarioDaRetomada(ultimaDela, { agora = new Date(), cfg = config.followup.silencio, sorteio = Math.random } = {}) {
  const base = new Date(ultimaDela).getTime();
  if (!Number.isFinite(base)) return null;

  const limite = base + cfg.limiteHoras * HORA_MS;
  const piso = Math.max(base + cfg.minimoHoras * HORA_MS, agora.getTime());
  if (piso > limite) return null;

  const alvo = new Date(Math.max(base + cfg.alvoHoras * HORA_MS, piso));
  if (alvo.getTime() <= limite && estaNaJanela(alvo)) return alvo;

  const abertura = dentroDaJanela(alvo).getTime();
  const comFolga = abertura + Math.floor(sorteio() * FOLGA_ABERTURA_RETOMADA_MIN * 60_000);
  if (comFolga <= limite) return new Date(comFolga);
  if (abertura <= limite) return new Date(abertura);

  const fechamento = fechamentoAnterior(alvo);
  if (!fechamento) return null;
  const [min, max] = FOLGA_FECHAMENTO_RETOMADA_MIN;
  const antes = fechamento.getTime() - Math.floor((min + sorteio() * (max - min)) * 60_000);
  return antes >= piso && antes <= limite ? new Date(antes) : null;
}

/**
 * Por que esta retomada agendada não pode mais sair, ou `null` se pode.
 *
 * É conferido de novo na hora do envio: entre o agendamento e a saída o
 * teto do número pode ter batido, o número pode ter caído, e a retomada que
 * sairia às 21 h de silêncio chegaria às 30. Fora das 24 h ela não sai — o
 * silêncio segue para o consultor.
 *
 * @param {{tipo: string, contexto?: object}} item
 */
export function motivoParaNaoRetomar(item, { agora = new Date(), cfg = config.followup.silencio } = {}) {
  if (TIPOS_SEGUNDA_RODADA.includes(item.tipo)) {
    return 'segunda tentativa não sai mais: sem resposta à primeira, a conversa vai para o consultor';
  }
  if (!TIPOS_RETOMADA.includes(item.tipo)) return null;

  const dela = Date.parse(item.contexto?.respondeu_em || '');
  if (!Number.isFinite(dela)) return 'agendada pela régua antiga, sem a hora da última mensagem do cliente';
  if (agora.getTime() > dela + cfg.envioLimiteHoras * HORA_MS) {
    return 'passou das 24 h da última mensagem do cliente';
  }
  return null;
}

/**
 * O que a régua faz com um lead em silêncio.
 *
 *  - `nada`: não é com ela (há mensagem agendada, já foi repassado neste
 *    silêncio, ou é resto da régua antiga, que `encerrarSemResposta` fecha).
 *  - `esperar`: é cedo — o silêncio é recente, ou a mensagem saiu e o dia
 *    dela ainda não passou.
 *  - `cutucar`: agendar a retomada única, em `quando`.
 *  - `repassar`: passar ao consultor. `causa` diz por quê: `retomada` (não
 *    respondeu à retomada), `pos_aula` (não respondeu à conversa de depois
 *    da aula) ou `sem_retomada` (não houve como retomar em 24 h).
 *
 * ## O silêncio é contado da última mensagem dela
 *
 * O que saiu antes da última resposta da pessoa é de outro silêncio. Quem
 * respondeu à retomada e sumiu de novo, dias depois, recebe outra — é uma
 * conversa nova, que ela reabriu.
 *
 * @param {object} p
 * @param {Array<{tipo, status, sent_at?, created_at?}>} p.followups
 * @param {string|Date|null} p.respondeuEm - A última mensagem da pessoa.
 * @param {string|Date} p.nossaUltimaEm - A nossa última fala, sem resposta.
 * @param {string|null} [p.repasseEm] - Quando este lead esteve com o consultor pela
 *   última vez por causa da régua (`metadata.followup_consultor_em`): o
 *   repasse, ou a devolução do handoff que emudeceu.
 * @param {boolean} [p.fezAula]
 */
export function decisaoDoSilencio({
  followups = [], respondeuEm = null, nossaUltimaEm, repasseEm = null, fezAula = false,
  agora = new Date(), cfg = config.followup.silencio, sorteio = Math.random,
} = {}) {
  if (followups.some(f => f.status === 'pendente')) {
    return { acao: 'nada', motivo: 'já há mensagem agendada' };
  }

  const corte = respondeuEm ? new Date(respondeuEm).getTime() : -Infinity;
  const quando = f => new Date(f.sent_at || f.created_at || 0).getTime();
  const doSilencio = followups.filter(f => quando(f) > corte);
  const enviados = doSilencio.filter(f => f.status === 'enviado' && TIPOS_REGUA.includes(f.tipo));

  if (repasseEm && new Date(repasseEm).getTime() > corte) {
    return { acao: 'nada', motivo: 'o consultor já teve este silêncio' };
  }
  if (enviados.some(f => TIPOS_SEGUNDA_RODADA.includes(f.tipo))) {
    return { acao: 'nada', motivo: 'recebeu as duas rodadas da régua antiga' };
  }

  // A Leia já escreveu por conta própria neste silêncio: é esperar o dia.
  if (enviados.length) {
    const ultimo = enviados.reduce((a, b) => (quando(b) > quando(a) ? b : a));
    const enviadoEm = new Date(quando(ultimo));
    if (!diaPassou(enviadoEm, agora)) {
      return { acao: 'esperar', motivo: 'a mensagem saiu e o dia dela ainda não passou' };
    }
    return {
      acao: 'repassar',
      causa: ultimo.tipo === 'ae_pos_aula' ? 'pos_aula' : 'retomada',
      enviadoEm: enviadoEm.toISOString(),
    };
  }

  // Ainda não escreveu. A retomada cabe?
  //
  // Não cabe para quem nunca escreveu (não há 24 h de quê), para quem já
  // teve uma tentativa que falhou neste silêncio (número que não existe, o
  // agente sem texto: insistir de hora em hora não conserta) e para quem
  // bateu o teto da vida.
  const falhou = doSilencio.some(f => f.status === 'falhou' && TIPOS_RETOMADA.includes(f.tipo));
  const naVida = followups.filter(f => f.status === 'enviado'
    && (TIPOS_RETOMADA.includes(f.tipo) || TIPOS_SEGUNDA_RODADA.includes(f.tipo))).length;

  if (respondeuEm && !falhou && naVida < TETO_RETOMADAS) {
    if (agora.getTime() - corte < cfg.agendarAposHoras * HORA_MS) {
      return { acao: 'esperar', motivo: 'silêncio recente' };
    }
    const horario = horarioDaRetomada(respondeuEm, { agora, cfg, sorteio });
    if (horario) return { acao: 'cutucar', tipo: fezAula ? 'sondagem_1' : 'silencio_1', quando: horario };
  }

  if (diaPassou(nossaUltimaEm, agora)) return { acao: 'repassar', causa: 'sem_retomada' };
  return { acao: 'esperar', motivo: 'sem horário para a retomada; o repasse espera a abertura seguinte' };
}

/** Prefixo do motivo do handoff que a régua abre. O painel mostra o texto como briefing. */
export const PREFIXO_REPASSE = '[follow-up]';

/**
 * A chave, em `crm_leads.metadata`, de quando o consultor teve o silêncio em
 * curso: gravada no repasse e na devolução do handoff que emudeceu. Uma
 * mensagem da pessoa depois dela abre outro silêncio, e a marca deixa de valer.
 */
export const MARCA_DO_CONSULTOR = 'followup_consultor_em';

/** `17/11 às 9h40`, em São Paulo. */
function diaHora(data) {
  const p = partesSP(new Date(data));
  const dois = n => String(n).padStart(2, '0');
  return `${dois(p.dia)}/${dois(p.mes + 1)} às ${p.hora}h${dois(p.minuto)}`;
}

/**
 * O briefing do repasse — o que o consultor lê no fio da conversa.
 *
 * @param {{causa: 'retomada'|'pos_aula'|'sem_retomada', enviadoEm?: string|null, respondeuEm?: string|null}} p
 */
export function textoDoRepasse({ causa, enviadoEm = null, respondeuEm = null }) {
  const oQue = causa === 'pos_aula'
    ? `Não respondeu à conversa de depois da aula experimental${enviadoEm ? ` (a Leia escreveu em ${diaHora(enviadoEm)})` : ''}.`
    : causa === 'retomada'
      ? `Não respondeu à retomada da Leia${enviadoEm ? ` (enviada em ${diaHora(enviadoEm)})` : ''}.`
      : 'Parou de responder, e não houve como retomar dentro de 24 h (fim de semana, feriado, teto do número ou número fora do ar).';
  const dela = respondeuEm ? ` Última mensagem do cliente: ${diaHora(respondeuEm)}.` : '';
  return `${PREFIXO_REPASSE} ${oQue}${dela} A Leia não escreve de novo nesta conversa: decidir se liga, escreve ou encerra.`;
}

/**
 * Passa ao consultor o lead que não respondeu.
 *
 * É um handoff como o que a Leia abre, com uma diferença: **nada é dito ao
 * cliente**. Mais uma mensagem sem resposta é exatamente o que a regra
 * existe para não mandar. A conversa vai para o modo humano, o lead entra
 * na fila "aguardando consultor" (quem já passou dessa etapa fica onde está
 * e aparece na fila pelo handoff aberto, `atendimento.js`), e o lead ganha a
 * marca `followup_consultor_em` (`MARCA_DO_CONSULTOR`) — é ela que impede a
 * régua de repassar o mesmo silêncio duas vezes quando a conversa voltar
 * para a Leia, e é por ela que `encerrarRepassadosSemResposta` fecha o lead.
 *
 * O handoff vem antes da marca: se a marca falhar, a conversa já está em
 * modo humano e a varredura não a enxerga mais, então não há laço.
 *
 * @returns {Promise<boolean>} `true` quando o repasse foi feito.
 */
async function repassarAoConsultor(alvo) {
  const { data: conversa } = await supabase
    .from('wa_conversations')
    .select('id')
    .eq('contact_id', alvo.contact_id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conversa) return false;

  const { data: lead } = await supabase.from('crm_leads').select('*').eq('id', alvo.lead_id).maybeSingle();
  if (!lead) return false;

  const texto = textoDoRepasse({ causa: alvo.causa, enviadoEm: alvo.enviadoEm, respondeuEm: alvo.respondeu_em });
  const handoff = await handoffToHuman(conversa.id, alvo.contact_id, texto);
  if (!handoff) {
    logger.error(`[followup] Lead ${lead.id}: o repasse ao consultor não foi registrado`);
    return false;
  }

  const agora = new Date().toISOString();
  const nota = texto.replace(`${PREFIXO_REPASSE} `, '');
  // A próxima ação que o consultor marcou para o futuro não é atropelada.
  const proximaLivre = !lead.next_action_at || Date.parse(lead.next_action_at) <= Date.now();

  await mudarEtapa(lead, 'aguardando_consultor', {
    actor: 'sistema',
    somenteAvanco: true,
    motivo: `Repasse da régua de follow-up: ${nota}`,
    campos: {
      metadata: { ...(lead.metadata || {}), [MARCA_DO_CONSULTOR]: agora, followup_consultor_via: `repasse:${alvo.causa}` },
      ...(proximaLivre ? { next_action_at: agora, next_action_note: nota } : {}),
    },
  });

  await registrarEvento(lead.id, {
    type: 'repasse_followup',
    actor: 'sistema',
    summary: nota,
    payload: {
      causa: alvo.causa,
      conversa_id: conversa.id,
      handoff_id: handoff.id,
      enviado_em: alvo.enviadoEm || null,
      respondeu_em: alvo.respondeu_em || null,
    },
  });

  logger.info(`[followup] Lead ${lead.id}: repassado ao consultor (${alvo.causa})`);
  return true;
}

/**
 * Tira da fila a retomada que não pode mais sair: a que passou das 24 h, a
 * agendada pela régua antiga e a segunda tentativa.
 *
 * Roda a cada ciclo, antes de tudo, e não só na hora do envio. O envio
 * confere o teto do número ANTES de olhar a linha: com o teto batido (ou em
 * recomeço) ela nunca chegaria a ser lida, ficaria `pendente`, e um lead com
 * pendente é um lead em que a varredura não mexe — nem para repassar.
 *
 * @returns {Promise<number>} quantas saíram da fila
 */
export async function expirarRetomadas({ agora = new Date() } = {}) {
  const { data, error } = await supabase
    .from('crm_followups')
    .select('id, lead_id, tipo, contexto')
    .eq('status', 'pendente')
    .in('tipo', [...TIPOS_RETOMADA, ...TIPOS_SEGUNDA_RODADA])
    .limit(500);

  if (error) {
    logger.warn(`[followup] Não deu para conferir as retomadas vencidas: ${error.message}`);
    return 0;
  }

  let canceladas = 0;
  for (const f of data || []) {
    const motivo = motivoParaNaoRetomar(f, { agora });
    if (motivo) canceladas += await cancelar(f.lead_id, [f.tipo], motivo);
  }
  return canceladas;
}

/**
 * As duas perguntas que saem para a rede, feitas só a quem já ia receber a
 * retomada ou ser repassado: este "lead" é um aluno com contrato ativo? E há
 * uma aula que o lead não conhece?
 *
 * @returns {Promise<null|'aluno'|'indefinido'|'com_aula'>} `null` = pode seguir.
 */
async function barradoNoEvo(lead, silencio, { simular, agora }) {
  // A resposta "não é aluno" não é refeita a cada hora.
  //
  // A varredura roda de 60 em 60 min e chegava aqui com ~35 candidatos,
  // dos quais 33 não tinham `evo_id_member` — para esses,
  // `situacaoComercial` gasta uma busca por telefone que não acha nada e
  // devolve 'lead'. Mesma pergunta, mesma resposta, ~840 requisições por
  // dia. A resposta negativa é estável: virar aluno é um FATO que chega
  // por webhook (`CreateMember`, `NewSale`) e pelo poller de conversão,
  // então nada se perde em não reperguntar por 24h.
  //
  // Só o NEGATIVO é guardado. 'aluno' já se persiste sozinho, logo
  // abaixo, mudando a trilha do contato — e 'indefinido' é EVO fora do
  // ar, que não é fato sobre a pessoa e não pode virar cache.
  const checadoEm = Date.parse(lead.metadata?.evo_nao_membro_em || '');
  const aindaVale = Number.isFinite(checadoEm)
    && agora - checadoEm < config.evo.membroChecagemHoras * 60 * 60 * 1000;

  const situacao = aindaVale ? 'lead' : await situacaoComercial(lead);

  if (situacao === 'lead' && !aindaVale && !simular) {
    // Merge, e não substituição: `metadata` é de uso geral, e uma
    // escrita cega apagaria o que outro caminho tenha posto lá.
    await supabase
      .from('crm_leads')
      .update({ metadata: { ...(lead.metadata || {}), evo_nao_membro_em: new Date().toISOString() } })
      .eq('id', lead.id)
      .then(({ error }) => {
        if (error) logger.warn(`[followup] Não deu para carimbar a checagem do lead ${lead.id}: ${error.message}`);
      });
  }

  if (situacao !== 'lead') {
    logger.info(`[followup] Lead ${lead.id} fora da varredura: ${situacao === 'aluno'
      ? 'é aluno com contrato ativo' : 'situação indefinida (EVO não respondeu)'}`);

    // Descobriu que é aluno? Então grave — a pergunta não precisa ser
    // feita de novo. Contrato ativo no EVO é a definição mais forte que
    // existe aqui: não depende de a Leia ter percebido, nem de alguém
    // ter marcado no painel. Da próxima varredura em diante ele sai pelo
    // filtro de trilha, sem custar chamada ao EVO, e o painel para de
    // contá-lo como pipeline.
    //
    // `indefinido` não grava nada de propósito: EVO fora do ar não é
    // fato sobre a pessoa, e gravar "aluno" por causa de um timeout
    // tiraria um lead de verdade do funil de forma permanente.
    //
    // ⚠️ E `simular` não grava NADA, nem isto. A simulação existe para o
    // consultor conferir a régua antes de soltá-la, e uma prévia que
    // reclassifica lead não é prévia — foi o que aconteceu na primeira
    // execução desta função depois da ramificação, em 31/08/2026: um
    // `--dry` moveu 9 leads para a trilha de relacionamento.
    if (situacao === 'aluno' && !simular) {
      try {
        await definirTipoDeContato(lead, 'aluno', {
          actor: 'sistema',
          motivo: 'contrato ativo no EVO',
        });
      } catch (err) {
        logger.warn(`[followup] Não deu para classificar o lead ${lead.id}: ${err.message}`);
      }
    }
    return situacao;
  }

  // A aula que o lead não conhece — marcada pela consultora direto no
  // EVO, num cadastro que o atendimento não tinha, ou vendida antes de
  // ter horário. Conta a aula desde que a conversa parou: a que vem pela
  // frente é motivo para não mexer, e a que aconteceu nesse meio-tempo
  // pede "como foi a aula?", não uma retomada de venda. As duas, ao serem
  // registradas, armam a régua da aula — e o pendente que ela cria já é o
  // que a próxima varredura vai respeitar.
  //
  // EVO fora do ar pula o lead nesta passada, como em `situacaoComercial`:
  // sem saber se há aula, não se retoma nem se repassa.
  const { evoSync } = await import('./evo-sync.js');
  const aula = await evoSync.conferirAulaNoEvo(lead, {
    desde: silencio.desde, registrar: !simular, actor: 'sistema',
  }).catch(err => {
    logger.warn(`[followup] Lead ${lead.id}: aula no EVO não conferida (${err.message})`);
    return { indefinido: true };
  });

  if (aula?.indefinido) return 'indefinido';
  if (aula && (aula.futura || aula.nova)) {
    logger.info(
      `[followup] Lead ${lead.id} fora da varredura: aula ${aula.futura ? 'marcada' : 'feita'} ` +
      `no EVO para ${aula.dataHora}${aula.nova ? ' — registrada agora' : ''}`
    );
    return 'com_aula';
  }
  return null;
}

/** Teto de leads lidos por varredura. A janela de 7 dias tem menos de cem. */
const TETO_LEADS_VARREDURA = 500;

/**
 * Varre os leads em silêncio: agenda a retomada de quem ainda está dentro
 * das 24 h, e repassa ao consultor quem não respondeu no dia.
 *
 * ## Por que uma varredura, e não um gatilho
 *
 * O resto da régua nasce de um FATO com hora marcada — a aula foi agendada,
 * o follow-up pós-aula foi enviado. Silêncio não é um fato: é a ausência
 * dele. Ninguém emite um evento "o cliente não respondeu". Só dá para
 * descobrir olhando.
 *
 * ## Olha a janela inteira, toda vez
 *
 * A régua antiga lia os 60 leads mais parados e parava no lote: quem estava
 * para cair fora da janela vinha primeiro, e os recentes esperavam a vez.
 * Agora o recente é o que tem prazo — a retomada dele vence em horas. Por
 * isso todos os leads da janela passam pela decisão (`decisaoDoSilencio`,
 * uma leitura de mensagens por lead), e só depois entram os tetos: a
 * retomada mais próxima de vencer primeiro, o repasse mais antigo primeiro.
 *
 * ## Os tetos
 *
 * `lote` limita as retomadas agendadas — quem chama passa o que ainda cabe
 * no teto do número, e zero em recomeço. `loteRepasse` e `repasse.tetoDia`
 * limitam os repasses: a fila do consultor não recebe o acumulado de uma
 * vez. Quem não coube espera a próxima varredura.
 *
 * @param {object}  opcoes
 * @param {boolean} opcoes.simular   Não grava nada; só devolve quem entraria.
 * @param {number}  opcoes.lote      Máximo de retomadas agendadas.
 * @param {boolean} opcoes.repassar  `false` não repassa ninguém nesta passada.
 * @returns {Promise<{agendados: number, repasses: number, leads: Array, examinados: number}>}
 */
export async function varrerSilenciosos(opcoes = {}) {
  const cfg = config.followup.silencio;
  const {
    janelaDias = cfg.janelaDias,
    lote = cfg.lote,
    repassar = cfg.repasse.habilitado,
    loteRepasse = cfg.repasse.lote,
    simular = false,
  } = opcoes;

  const agora = Date.now();
  const piso = new Date(agora - janelaDias * DIA_MS).toISOString();
  const vazio = { agendados: 0, repasses: 0, leads: [], examinados: 0 };

  // `last_activity_at` NÃO serve de corte superior: ele é encostado também
  // por mudança de etapa e por envio nosso, então um lead em silêncio há 3
  // dias pode ter atividade de hoje. Ele serve só de piso — quem não teve
  // nenhuma atividade na janela está fora do escopo "leads desta semana".
  const { data: leads, error } = await supabase
    .from('crm_leads')
    .select('id, full_name, phone, stage, contact_id, last_activity_at, evo_id_member, evo_id_prospect, experimental_at, experimental_status, metadata')
    // A régua é de VENDA: quem já foi classificado como aluno, convênio,
    // fornecedor ou engano nem entra na consulta.
    .eq('trilha', 'lead')
    .not('stage', 'in', FILTRO_ETAPAS_FECHADAS)
    .not('contact_id', 'is', null)
    .not('phone', 'is', null)
    .gte('last_activity_at', piso)
    .order('last_activity_at', { ascending: true })
    .limit(TETO_LEADS_VARREDURA);

  if (error) {
    logger.error('[followup] Varredura de silêncio falhou:', error.message);
    return vazio;
  }
  // Também loga: este é justamente o caso que ficava mudo e virava dúvida
  // sobre o worker estar vivo. Zero candidato na janela não é normal com
  // movimento — é sinal de filtro ou janela errados.
  if (!leads?.length) {
    logger.info(`[followup] Varredura de silêncio: nenhum lead na janela de ${janelaDias}d`);
    return vazio;
  }

  // O que já correu para esses leads.
  //
  // `cancelado` fica de fora de propósito: um follow-up cancelado porque a
  // pessoa respondeu não pode bloquear a próxima vez que ela sumir. `falhou`
  // entra porque a decisão precisa dele para não reagendar de hora em hora a
  // retomada cujo envio falha. Paginado: são várias linhas por lead, e o
  // Supabase corta em 1000.
  const { data: feitos, error: erroFeitos } = await lerTodas(() => supabase
    .from('crm_followups')
    .select('id, lead_id, tipo, status, sent_at, created_at')
    .in('lead_id', leads.map(l => l.id))
    .in('status', ['pendente', 'enviado', 'falhou']));

  if (erroFeitos) {
    // Sem saber o que já saiu, a decisão erraria para o lado de mandar de novo.
    logger.error('[followup] Varredura de silêncio: falha ao ler o que já foi enviado:', erroFeitos.message);
    return vazio;
  }

  const porLead = new Map();
  for (const f of feitos || []) {
    if (!porLead.has(f.lead_id)) porLead.set(f.lead_id, []);
    porLead.get(f.lead_id).push(f);
  }

  // Conversa aberta e não assumida por humano. Com o consultor, quem fala é ele.
  const { data: conversas } = await supabase
    .from('wa_conversations')
    .select('contact_id, status')
    .in('contact_id', leads.map(l => l.contact_id))
    .eq('status', 'active');

  const comConversa = new Set((conversas || []).map(c => c.contact_id));

  // Quantos repasses ainda cabem hoje. Sem conseguir contar, nenhum.
  let vagasDeRepasse = 0;
  if (repassar) {
    const inicioDoDia = deSP({ ...partesSP(new Date(agora)), hora: 0, minuto: 0 }).toISOString();
    const { count, error: erroConta } = await supabase
      .from('crm_lead_events')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'repasse_followup')
      .gte('occurred_at', inicioDoDia);

    if (erroConta) logger.warn(`[followup] Não deu para contar os repasses de hoje: ${erroConta.message}`);
    else vagasDeRepasse = Math.max(0, Math.min(loteRepasse, cfg.repasse.tetoDia - (count ?? 0)));
  }

  // 1. A decisão de cada lead — barata: uma leitura de mensagens.
  const candidatos = [];
  const ignorados = {};
  let examinados = 0;
  let emSilencio = 0;

  for (const lead of leads) {
    if (!comConversa.has(lead.contact_id)) continue;

    // Lixo de cadastro não vira agendamento nem trabalho para o consultor.
    if (String(lead.phone).startsWith('teste')) continue;
    if (!telefoneValido(lead.phone)) {
      logger.debug(`[followup] Lead ${lead.id} fora da varredura: telefone ${lead.phone}`);
      continue;
    }

    const feitosDoLead = porLead.get(lead.id) || [];
    if (feitosDoLead.some(f => f.status === 'pendente')) continue;

    // Quem tem aula marcada não está sumido: a próxima conversa é a da
    // aula. Até 29/10/2026 a régua não olhava isso, e a Amanda recebeu o
    // "tudo bem se não for o momento" três dias antes da aula da Emily.
    // Os dois sinais daqui são de graça; o EVO é perguntado mais abaixo.
    if (temAulaPorVir(lead, agora) || lead.metadata?.aula_vendida) {
      ignorados.com_aula = (ignorados.com_aula || 0) + 1;
      continue;
    }

    examinados++;

    const silencio = await estadoDoSilencio(lead.contact_id);
    if (!silencio) continue;
    emSilencio++;

    const decisao = decisaoDoSilencio({
      followups: feitosDoLead,
      respondeuEm: silencio.respondeuEm,
      nossaUltimaEm: silencio.desde,
      repasseEm: lead.metadata?.[MARCA_DO_CONSULTOR] || null,
      fezAula: lead.stage === 'experimental_realizada',
      agora: new Date(agora),
    });

    if (decisao.acao === 'cutucar' || decisao.acao === 'repassar') {
      candidatos.push({ lead, silencio, decisao });
    }
  }

  // 2. Os tetos, e só então as perguntas que saem para a rede.
  const paraCutucar = candidatos
    .filter(c => c.decisao.acao === 'cutucar')
    .sort((a, b) => a.decisao.quando - b.decisao.quando);
  const paraRepassar = candidatos
    .filter(c => c.decisao.acao === 'repassar')
    .sort((a, b) => a.silencio.desde - b.silencio.desde);

  const selecionados = [];
  const conta = { cutucar: 0, repassar: 0 };
  const teto = { cutucar: Math.max(0, lote), repassar: vagasDeRepasse };

  for (const { lead, silencio, decisao } of [...paraCutucar, ...paraRepassar]) {
    if (conta[decisao.acao] >= teto[decisao.acao]) continue;

    const barrado = await barradoNoEvo(lead, silencio, { simular, agora });
    if (barrado) {
      ignorados[barrado] = (ignorados[barrado] || 0) + 1;
      continue;
    }

    conta[decisao.acao]++;
    selecionados.push({
      lead_id: lead.id,
      contact_id: lead.contact_id,
      nome: lead.full_name,
      etapa: lead.stage,
      acao: decisao.acao,
      tipo: decisao.tipo || null,
      causa: decisao.causa || null,
      enviadoEm: decisao.enviadoEm || null,
      agendado_para: decisao.quando ? decisao.quando.toISOString() : null,
      dias_parado: silencio.dias,
      calado_desde: silencio.desde.toISOString(),
      respondeu_em: silencio.respondeuEm ? silencio.respondeuEm.toISOString() : null,
      ultima_fala_de: silencio.porQuem,
    });
  }

  // A varredura SEMPRE diz o que fez, inclusive quando não fez nada.
  //
  // Antes ela só logava quando agendava algo, e o silêncio no log era
  // ambíguo de um jeito caro: "rodou e não achou ninguém" ficava idêntico a
  // "não rodou" — e as duas coisas exigem investigações opostas. Uma linha
  // por hora é barata; não saber se o worker está vivo, não.
  const descartes = [
    ignorados.aluno ? `${ignorados.aluno} aluno(s) ativo(s)` : null,
    ignorados.indefinido ? `${ignorados.indefinido} sem resposta do EVO` : null,
    ignorados.com_aula ? `${ignorados.com_aula} com aula experimental` : null,
  ].filter(Boolean).join(', ');

  const naFilaDoRepasse = paraRepassar.length - conta.repassar;
  const resumo =
    `${leads.length} lead(s) na janela de ${janelaDias}d, ${examinados} examinado(s), ${emSilencio} em silêncio; ` +
    `${paraCutucar.length} para retomar (teto ${teto.cutucar}), ` +
    `${paraRepassar.length} para o consultor (${repassar ? `teto ${teto.repassar}` : 'repasse parado nesta passada'})` +
    (descartes ? ` (fora: ${descartes})` : '');

  if (simular) {
    logger.info(`[followup] Varredura (SIMULAÇÃO): ${resumo} — nada gravado`);
    return { agendados: 0, repasses: 0, leads: selecionados, examinados, simulado: true };
  }

  let agendados = 0;
  let repasses = 0;
  for (const alvo of selecionados) {
    if (alvo.acao === 'cutucar') {
      const criado = await agendar(alvo.lead_id, alvo.tipo, new Date(alvo.agendado_para), {
        origem: 'retomada_24h',
        respondeu_em: alvo.respondeu_em,
        calado_desde: alvo.calado_desde,
        dias_parado: alvo.dias_parado,
        ultima_fala_de: alvo.ultima_fala_de,
      });
      if (criado) agendados++;
    } else if (await repassarAoConsultor(alvo)) {
      repasses++;
    }
  }

  logger.info(
    `[followup] Varredura de silêncio: ${resumo} → ${agendados} retomada(s) agendada(s), ` +
    `${repasses} repassado(s) ao consultor` +
    (repassar && naFilaDoRepasse > 0 ? `, ${naFilaDoRepasse} esperando vaga de repasse` : '')
  );
  return { agendados, repasses, leads: selecionados, examinados };
}

/** Conversas do simulador não são atendimento — ficam fora da devolução. */
const CANAL_SIMULADOR = 'web-test';

/** Teto de conversas examinadas por devolução, para a varredura ser barata. */
const TETO_EXAME_HANDOFF = 80;

/**
 * Devolve à Leia o handoff em que o cliente parou de responder.
 *
 * ## O buraco que ela fecha
 *
 * `aoConsultorAssumir` cala o bot (`status = 'human'`), e isso é o certo
 * enquanto o atendimento está acontecendo. Mas nada nunca reabria essa
 * porta: a varredura de silêncio filtra `status = 'active'`, o worker
 * cancela o que já estava agendado ("conversa está com o consultor"), e as
 * duas rotinas de encerramento não alcançam o caso — `encerrarSemResposta`
 * exige uma segunda rodada que nunca foi enviada, e
 * `encerrarRelacionamentosParados` só mexe na trilha que não é venda.
 *
 * Resultado: lead que vai para o consultor e some não é cutucado, não é
 * encerrado e não sai do painel. Medido em 12/09/2026: 98 leads, mediana
 * de 8,6 dias parados, 81 deles sem um único follow-up na vida.
 *
 * ## O que ela NÃO faz
 *
 * Não devolve quem está em `aguardando_consultor`: ali o handoff foi
 * aberto e ninguém pegou. Isso é fila atrasada, não silêncio do cliente, e
 * devolver para a Leia esconderia o problema em vez de resolvê-lo.
 *
 * Não devolve quando a última mensagem é do CLIENTE. Nesse caso quem sumiu
 * foi o consultor, e a pessoa está esperando gente — mandar a Leia
 * responder por cima é o pior dos dois mundos. Esse caso já tem dono: o
 * cartão "aguardando resposta" de `atendimento.js`.
 *
 * Não muda a etapa nem o `assigned_to`. A etapa continua `com_consultor`
 * porque é isso que aconteceu, e zerar o dono apagaria quem atendeu. O que
 * muda é só quem tem a palavra agora.
 *
 * ## O que acontece depois (desde 16/11/2026)
 *
 * A régua não retoma mais com dias de silêncio, e mandar a conversa de volta
 * ao consultor que acabou de perdê-la seria um vaivém. Por isso a devolução
 * grava no lead a marca de que o consultor já teve este silêncio
 * (`MARCA_DO_CONSULTOR`): a varredura não mexe nele, e
 * `encerrarRepassadosSemResposta` o dá como perdido quando a nossa última
 * fala completa `FOLLOWUP_DIAS_ATE_PERDIDO` sem resposta. Se a pessoa
 * escrever, é conversa nova e a Leia responde.
 *
 * @param {object}  opcoes
 * @param {boolean} opcoes.simular  Não grava nada; só devolve quem entraria.
 */
export async function retomarHandoffsMudos(opcoes = {}) {
  const cfg = config.followup.handoff;
  const { dias = cfg.dias, lote = cfg.lote, simular = false } = opcoes;

  // `habilitado` NÃO é conferido aqui, e sim em quem chama pelo worker —
  // mesmo arranjo de `varrerSilenciosos`. A chave desliga a automação, não
  // a régua: a simulação pelo painel precisa funcionar justamente enquanto
  // ela está desligada, que é quando se decide se pode ligar.
  if (!dias || dias <= 0) return { retomados: 0, leads: [] };

  const corte = new Date(Date.now() - dias * DIA_MS).toISOString();

  // `last_message` é só um pré-filtro barato: ele é encostado pela chegada
  // da mensagem do cliente e pela resposta do painel, mas não pela resposta
  // digitada no aparelho. Quem decide é a última mensagem de verdade, lida
  // adiante — este corte serve para não trazer as 140 conversas humanas.
  const { data: conversas, error } = await supabase
    .from('wa_conversations')
    .select('id, contact_id, assigned_to, last_message')
    .eq('status', 'human')
    .neq('channel', CANAL_SIMULADOR)
    .not('last_message', 'is', null)
    .lte('last_message', corte)
    .order('last_message', { ascending: true })
    .limit(TETO_EXAME_HANDOFF * 2);

  if (error) {
    logger.error('[followup] Devolução de handoff falhou:', error.message);
    return { retomados: 0, leads: [] };
  }
  if (!conversas?.length) return { retomados: 0, leads: [] };

  const { data: leads } = await supabase
    .from('crm_leads')
    .select('id, full_name, stage, contact_id, metadata')
    .in('contact_id', conversas.map(c => c.contact_id))
    .eq('trilha', 'lead')
    .not('stage', 'in', FILTRO_ETAPAS_FECHADAS)
    .neq('stage', 'aguardando_consultor');

  const porContato = new Map((leads || []).map(l => [l.contact_id, l]));
  const selecionados = [];
  let examinadas = 0;
  let noVacuo = 0;

  for (const conversa of conversas) {
    if (selecionados.length >= lote) break;
    if (examinadas >= TETO_EXAME_HANDOFF) break;

    const lead = porContato.get(conversa.contact_id);
    if (!lead) continue;
    examinadas++;

    const { data: ultima } = await supabase
      .from('wa_messages')
      .select('direction, created_at, sent_by')
      .eq('conversation_id', conversa.id)
      .order('created_at', { ascending: false })
      .limit(1);

    const m = ultima?.[0];
    if (!m) continue;

    // Cliente falou por último: o vácuo é nosso, e não é esta régua que
    // resolve.
    if (m.direction === 'inbound') { noVacuo++; continue; }

    // `last_message` podia estar atrasado em relação à conversa real.
    const calado = Date.now() - new Date(m.created_at).getTime();
    if (calado < dias * DIA_MS) continue;

    selecionados.push({
      lead_id: lead.id,
      conversa_id: conversa.id,
      nome: lead.full_name,
      etapa: lead.stage,
      consultor: conversa.assigned_to || null,
      dias_parado: Math.floor(calado / DIA_MS),
      ultima_fala_de: m.sent_by || null,
    });
  }

  const resumo =
    `${conversas.length} conversa(s) em modo humano no corte de ${dias}d, ` +
    `${examinadas} examinada(s), ${selecionados.length} com o cliente calado` +
    (noVacuo ? ` (${noVacuo} esperando o consultor, fora desta régua)` : '');

  if (simular) {
    logger.info(`[followup] Devolução de handoff (SIMULAÇÃO): ${resumo} — nada gravado`);
    return { retomados: 0, leads: selecionados, simulado: true };
  }

  let retomados = 0;
  for (const alvo of selecionados) {
    const { error: falha } = await supabase
      .from('wa_conversations')
      .update({ status: 'active', ai_enabled: true })
      .eq('id', alvo.conversa_id);

    if (falha) {
      logger.warn(`[followup] Não deu para devolver a conversa ${alvo.conversa_id}: ${falha.message}`);
      continue;
    }

    // O consultor já teve este silêncio: a régua não repassa de volta.
    const { error: semMarca } = await supabase
      .from('crm_leads')
      .update({
        metadata: {
          ...(leads || []).find(l => l.id === alvo.lead_id)?.metadata,
          [MARCA_DO_CONSULTOR]: new Date().toISOString(),
          followup_consultor_via: 'devolucao',
        },
      })
      .eq('id', alvo.lead_id);
    if (semMarca) logger.warn(`[followup] Lead ${alvo.lead_id}: a marca da devolução não foi gravada (${semMarca.message})`);

    await registrarEvento(alvo.lead_id, {
      type: 'handoff_devolvido',
      actor: 'sistema',
      summary:
        `Cliente sem responder há ${alvo.dias_parado} dia(s) desde a última fala nossa — ` +
        'conversa devolvida à Leia; sem resposta, o lead é encerrado',
      payload: {
        conversa_id: alvo.conversa_id,
        consultor: alvo.consultor,
        dias_parado: alvo.dias_parado,
        ultima_fala_de: alvo.ultima_fala_de,
      },
    }).catch(err => logger.warn(`[followup] Evento de devolução falhou: ${err.message}`));

    // Sem isto a devolução não devolve nada.
    //
    // `varrerSilenciosos` usa `last_activity_at` como PISO da janela de 7
    // dias, e o handoff mudo típico está calado há mais que isso — a
    // mediana medida era 8,6 dias. A conversa voltaria para `active` e o
    // lead continuaria invisível para a régua, que é exatamente o estado
    // do qual estamos tirando ele.
    //
    // Encostar a coluna é honesto: ela responde "quando este lead se
    // mexeu pela última vez", e reabrir o atendimento É movimento. O que
    // o painel mostra como "na etapa há" é `stage_since`, e esse não se
    // toca — a idade do travamento continua visível.
    await tocarAtividade(alvo.lead_id);

    retomados++;
  }

  logger.info(`[followup] Devolução de handoff: ${resumo} → ${retomados} devolvida(s) à Leia`);
  return { retomados, leads: selecionados };
}

/**
 * Quantas vezes um mesmo follow-up pode falhar antes de desistir.
 *
 * O número está em UM lugar porque ele aparece nos dois lados de uma
 * mesma regra, e quando os dois lados discordam a linha some do mundo:
 * `vencidos` deixa de enxergá-la, `registrarTentativa` deixa de mexer
 * nela, e ela fica `pendente` para sempre. `decisaoDoSilencio` não mexe
 * em quem tem qualquer pendente — então essa linha órfã não é só
 * lixo, é uma proibição permanente de follow-up para aquele lead.
 *
 * Em 12/09/2026 havia 29 leads nesse estado, 27 deles por `Evolution API
 * 400` (número que não existe no WhatsApp) numa única tarde de 31/08.
 */
const TETO_TENTATIVAS = 3;

/** Follow-ups vencidos, prontos para envio. */
export async function vencidos(limite = 20) {
  const { data, error } = await supabase
    .from('crm_followups')
    .select(`
      id, tipo, scheduled_for, contexto, tentativas,
      lead:crm_leads (
        id, full_name, phone, stage, trilha, contact_id, interest,
        evo_id_prospect, evo_id_member, experimental_at, experimental_activity, experimental_status, metadata
      )
    `)
    .eq('status', 'pendente')
    .lte('scheduled_for', new Date().toISOString())
    .lt('tentativas', TETO_TENTATIVAS)
    .order('scheduled_for', { ascending: true })
    .limit(limite);

  if (error) {
    logger.error('[followup] Falha ao buscar vencidos:', error.message);
    return [];
  }
  return data || [];
}

/** Marca o resultado do envio. */
export async function registrarEnvio(followupId, { mensagem, presenca, erro = null }) {
  await supabase
    .from('crm_followups')
    .update({
      status: erro ? 'falhou' : 'enviado',
      mensagem: mensagem || null,
      presenca: presenca || null,
      erro,
      sent_at: erro ? null : new Date().toISOString(),
      tentativas: undefined,
    })
    .eq('id', followupId);
}

/** Incrementa tentativas sem mudar o status (para nova tentativa depois). */
export async function registrarTentativa(followupId, tentativas, erro) {
  const agora = tentativas + 1;
  const esgotou = agora >= TETO_TENTATIVAS;

  await supabase
    .from('crm_followups')
    .update({
      tentativas: agora,
      erro: String(erro).slice(0, 400),
      ...(esgotou ? { status: 'falhou' } : {}),
    })
    .eq('id', followupId);

  if (esgotou) {
    logger.warn(
      `[followup] Follow-up ${followupId} esgotou ${TETO_TENTATIVAS} tentativas — ` +
      'marcado como falhou para não travar a régua do lead'
    );
  }
}

/** Anota o follow-up no razão do lead. */
export async function registrarNoFunil(leadId, tipo, resumo, payload = {}) {
  await registrarEvento(leadId, {
    type: 'followup_enviado',
    actor: 'leia',
    summary: resumo,
    payload: { tipo, ...payload },
  });
}

export const followup = {
  JANELA, JANELAS, janelaDoDia, dentroDaJanela, estaNaJanela, horarioDoLembrete, horarioDoPosAula, lembreteNecessario,
  TIPOS_SILENCIO, TIPOS_REGUA, TIPOS_RETOMADA, TIPOS_SEGUNDA_RODADA, TETO_RETOMADAS, PREFIXO_REPASSE,
  MARCA_DO_CONSULTOR, estadoDoSilencio,
  aberturaSeguinte, diaPassou, horarioDaRetomada, motivoParaNaoRetomar, decisaoDoSilencio, textoDoRepasse,
  agendar, cancelar, aoAgendarExperimental, varrerSilenciosos, expirarRetomadas,
  retomarHandoffsMudos,
  vencidos, registrarEnvio, registrarTentativa, registrarNoFunil, situacaoComercial,
};
