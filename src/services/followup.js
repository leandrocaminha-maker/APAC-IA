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
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import {
  registrarEvento, definirTipoDeContato, tocarAtividade, FILTRO_ETAPAS_FECHADAS,
} from './funil.js';
// Sem ciclo: `evolution.js` só importa config e logger.
import { telefoneValido } from './evolution.js';
import { evoClient } from './evo-client.js';

/**
 * Janela de contato ativo, em horário de São Paulo.
 *
 * Vale para toda mensagem que **parte** da academia. Responder quem
 * escreveu é outra coisa e vale a qualquer hora.
 *
 *   segunda a sexta   9h00 – 20h30
 *   sábado            9h00 – 13h00
 *   domingo           sem contato
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

/** A janela de contato do dia em que `data` cai, ou `null` se for domingo. */
export function janelaDoDia(data) {
  return JANELAS[partesSP(data).diaSemana];
}

/**
 * Abertura do primeiro dia com contato a partir de `desloc` dias adiante.
 *
 * O laço vai até 7 porque com um único dia fechado na semana ele nunca dá
 * mais de dois passos — mas escrito assim ele continua correto se o
 * domingo virar dois dias, ou se um feriado entrar em `JANELAS`.
 */
function proximaAbertura(p, desloc = 1) {
  for (let i = desloc; i < desloc + 7; i++) {
    const janela = JANELAS[(p.diaSemana + i) % 7];
    if (janela) return deSP({ ...p, dia: p.dia + i, hora: 0, minuto: janela.inicioMin });
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
  const hoje = JANELAS[p.diaSemana];

  if (hoje && minutos >= hoje.inicioMin && minutos <= hoje.fimMin) return data;
  if (hoje && minutos < hoje.inicioMin) {
    return deSP({ ...p, hora: 0, minuto: hoje.inicioMin });
  }
  return proximaAbertura(p);
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
 */
export function horarioDoLembrete(aula) {
  const ideal = new Date(aula.getTime() - 24 * 60 * 60 * 1000);
  const candidato = dentroDaJanela(ideal);

  if (candidato.getTime() <= aula.getTime() - LEMBRETE_ANTECEDENCIA_MIN_MS) {
    return candidato;
  }

  // O laço começa no próprio dia do ideal (i = 0), e não no anterior: para
  // a aula de domingo à tarde, o ideal é sábado à tarde — o dia certo, só
  // que fora da janela. Prender às 13h resolve sem sair do sábado.
  const pi = partesSP(ideal);
  const minutosIdeal = pi.hora * 60 + pi.minuto;

  for (let i = 0; i <= 7; i++) {
    const janela = JANELAS[(pi.diaSemana - i + 7) % 7];
    if (!janela) continue;
    const minuto = Math.min(Math.max(minutosIdeal, janela.inicioMin), janela.fimMin);
    const recuado = deSP({ ...pi, dia: pi.dia - i, hora: 0, minuto });
    if (recuado.getTime() < aula.getTime()) return recuado;
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

/**
 * Chamado quando a aula experimental é agendada.
 *
 * Dois follow-ups nascem juntos porque nascem do mesmo fato:
 *
 *  - **24h antes**: confirmar presença e reforçar o valor de ir. É o
 *    momento em que a pessoa decide se vai mesmo, e um lembrete muda essa
 *    taxa mais do que qualquer argumento depois.
 *  - **4h depois**: consultar presença e conversar de acordo. Quatro horas
 *    dão tempo de a academia marcar a presença no sistema sem a conversa
 *    esfriar.
 */
export async function aoAgendarExperimental(lead, { dataHora, atividade }) {
  const aula = new Date(String(dataHora).replace(' ', 'T') + ':00-03:00');
  if (Number.isNaN(aula.getTime())) return;

  const contexto = { aula: aula.toISOString(), atividade: atividade || null };

  // 24h antes, exceto quando isso cai em domingo — ver `horarioDoLembrete`.
  const lembrete = horarioDoLembrete(aula);

  // Aula perto demais não recebe lembrete: ele chegaria depois da aula, ou
  // junto com a confirmação que a pessoa acabou de receber. A conta é feita
  // sobre o horário já ajustado, e não sobre as 24h cruas, porque é o
  // ajustado que vai sair — o recuo para sábado pode deixá-lo no passado
  // quando a aula de segunda é marcada no próprio domingo.
  if (lembrete.getTime() > Date.now() + 30 * 60 * 1000) {
    await agendar(lead.id, 'ae_lembrete_24h', lembrete, contexto);
  } else {
    logger.info(`[followup] Lead ${lead.id}: aula perto demais (ou lembrete no passado), sem lembrete`);
  }

  await agendar(lead.id, 'ae_pos_aula', new Date(aula.getTime() + 4 * 60 * 60 * 1000), contexto);
}

/**
 * Depois do follow-up pós-aula, decide se abre nova rodada de sondagem.
 *
 * Teto de duas rodadas, e depois o lead é dado como perdido de forma
 * explícita. Sem teto isto vira perseguição — e um "perdido" honesto vale
 * mais para o funil do que um lead eternamente "em conversa" que ninguém
 * mais vai atender.
 */
export async function proximaSondagem(lead) {
  const { data: feitas } = await supabase
    .from('crm_followups')
    .select('tipo')
    .eq('lead_id', lead.id)
    .in('tipo', ['sondagem_1', 'sondagem_2'])
    .in('status', ['enviado', 'pendente']);

  const jaFeitas = new Set((feitas || []).map(f => f.tipo));

  if (!jaFeitas.has('sondagem_1')) {
    return { tipo: 'sondagem_1', quando: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) };
  }
  if (!jaFeitas.has('sondagem_2')) {
    return { tipo: 'sondagem_2', quando: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000) };
  }
  return null;   // acabou: o chamador marca como perdido
}

// ──────────────────────────────────────────────
// Régua do silêncio: o lead que parou de responder
//
// A régua pós-aula acima só existe para quem marcou experimental. Quem
// sumiu antes disso — no meio da conversa, depois de ouvir o preço, depois
// de o consultor prometer um retorno — não tinha nenhum turno em que
// alguém agisse. Esta seção é esse turno.
//
// O relógio é a NOSSA última fala sem resposta. Dois dias dela → 1ª
// cutucada; como a própria cutucada vira a nossa última fala, mais dois
// dias de silêncio → 2ª, que cai no 4º dia. Não há encadeamento em
// código: a mesma regra, aplicada duas vezes, produz "2 e 4 dias".
//
// O efeito colateral disso é o desejado: se o consultor responder à mão no
// dia 3, a mensagem dele passa a ser a nossa última fala e o relógio
// reinicia — que é exatamente o que "2 dias após a última resposta da Leia
// ou do consultor" quer dizer.
// ──────────────────────────────────────────────

const DIA_MS = 24 * 60 * 60 * 1000;

export const TIPOS_SILENCIO = ['silencio_1', 'silencio_2'];
const TIPOS_SONDAGEM = ['sondagem_1', 'sondagem_2'];

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
 */
function ehNossaFala(sentBy) {
  const quem = String(sentBy || '');
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
async function estadoDoSilencio(contactId) {
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
 * Decide qual rodada de silêncio cabe a um lead, olhando o que já correu.
 *
 * Devolve `null` — isto é, "não mexa" — em três situações:
 *
 *  - **Já existe follow-up pendente**, de qualquer tipo. O lembrete da aula
 *    de amanhã já é a próxima mensagem; somar uma cutucada faria a pessoa
 *    receber duas.
 *  - **A régua pós-aula já correu.** `sondagem_*` É o silêncio de quem
 *    passou pela experiência. Abrir `silencio_*` em cima seria dar quatro
 *    rodadas a quem a régua deu duas — e a segunda dupla chegaria sem nada
 *    novo a dizer.
 *  - **As duas rodadas de silêncio já se esgotaram.** Acabou. O teto é o
 *    mesmo das sondagens, pela mesma razão: sem teto isto vira perseguição.
 */
function rodadaDeSilencio(followupsDoLead) {
  const pendente = followupsDoLead.some(f => f.status === 'pendente');
  if (pendente) return null;

  const enviados = new Set(
    followupsDoLead.filter(f => f.status === 'enviado').map(f => f.tipo)
  );

  if (TIPOS_SONDAGEM.some(t => enviados.has(t))) return null;

  // Uma rodada também se esgota por falha repetida.
  //
  // Linha `falhou` não é `pendente`, então a fila nunca a tenta de novo — e
  // como a varredura só é bloqueada por `pendente` e `enviado`, sem este
  // teto ela abriria uma linha nova a cada hora, para sempre, no lead cujo
  // envio falha de forma permanente. Duas tentativas absorvem o erro
  // passageiro (o agente não gerar texto) sem virar laço.
  const falhas = {};
  for (const f of followupsDoLead) {
    if (f.status === 'falhou') falhas[f.tipo] = (falhas[f.tipo] || 0) + 1;
  }
  const esgotada = t => enviados.has(t) || (falhas[t] || 0) >= 2;

  if (!esgotada('silencio_1')) return 'silencio_1';
  if (!esgotada('silencio_2')) return 'silencio_2';
  return null;
}

/**
 * Varre os leads parados e agenda a cutucada de quem está em silêncio.
 *
 * ## Por que uma varredura, e não um gatilho
 *
 * O resto da régua nasce de um FATO com hora marcada — a aula foi agendada,
 * o follow-up pós-aula foi enviado. Silêncio não é um fato: é a ausência
 * dele. Ninguém emite um evento "o cliente não respondeu". Só dá para
 * descobrir olhando.
 *
 * ## Por que `>= dias`, e não `== dias`
 *
 * Um lead parado há 5 dias que nunca recebeu cutucada continua elegível: o
 * corte é um piso, não uma igualdade. É isso que faz esta mesma função
 * servir de recuperação do acumulado, sem código separado de backfill — e é
 * por isso que ela precisa de `janelaDias` como teto. Sem esse teto, a
 * primeira execução acordaria lead de meses atrás, para quem uma retomada
 * não é retomada, é abordagem fria.
 *
 * ## Espaçamento
 *
 * Os agendamentos saem espalhados de `intervaloMin` em `intervaloMin`. 15
 * mensagens no mesmo minuto é o que denuncia robô — e satura a instância.
 *
 * @param {object}  opcoes
 * @param {boolean} opcoes.simular  Não grava nada; só devolve quem entraria.
 * @returns {Promise<{agendados: number, leads: Array, examinados: number}>}
 */
export async function varrerSilenciosos(opcoes = {}) {
  const cfg = config.followup.silencio;
  const {
    dias = cfg.dias,
    janelaDias = cfg.janelaDias,
    lote = cfg.lote,
    intervaloMin = cfg.intervaloMin,
    simular = false,
  } = opcoes;

  const agora = Date.now();
  const piso = new Date(agora - janelaDias * DIA_MS).toISOString();

  // `last_activity_at` NÃO serve de corte superior: ele é encostado também
  // por mudança de etapa e por envio nosso, então um lead em silêncio há 3
  // dias pode ter atividade de hoje. Ele serve só de piso — quem não teve
  // nenhuma atividade na janela está fora do escopo "leads desta semana".
  //
  // A ordem é do mais parado para o menos: são os que estão prestes a cair
  // fora da janela, e o `break` do lote não pode deixá-los para trás.
  const { data: leads, error } = await supabase
    .from('crm_leads')
    .select('id, full_name, phone, stage, contact_id, last_activity_at, evo_id_member')
    // A régua é de VENDA, e agora existe onde perguntar isso.
    //
    // Antes a única defesa era `situacaoComercial`, no fim do laço, e ela
    // custa uma ida ao EVO por lead. Com a ramificação, quem já foi
    // classificado como aluno, convênio, fornecedor ou engano nem entra na
    // consulta — a pergunta cara sobra só para quem ninguém classificou
    // ainda, que é exatamente o caso em que ela é necessária.
    .eq('trilha', 'lead')
    .not('stage', 'in', FILTRO_ETAPAS_FECHADAS)
    .not('contact_id', 'is', null)
    .not('phone', 'is', null)
    .gte('last_activity_at', piso)
    .order('last_activity_at', { ascending: true })
    .limit(Math.max(lote * 6, 60));

  if (error) {
    logger.error('[followup] Varredura de silêncio falhou:', error.message);
    return { agendados: 0, leads: [], examinados: 0 };
  }
  // Também loga: este é justamente o caso que ficava mudo e virava dúvida
  // sobre o worker estar vivo. Zero candidato na janela não é normal com
  // movimento — é sinal de filtro ou janela errados.
  if (!leads?.length) {
    logger.info(`[followup] Varredura de silêncio: nenhum lead na janela de ${janelaDias}d`);
    return { agendados: 0, leads: [], examinados: 0 };
  }

  // O que já correu para esses leads, numa consulta só.
  //
  // `cancelado` fica de fora de propósito: um follow-up cancelado porque a
  // pessoa respondeu não pode bloquear a próxima vez que ela sumir — é
  // assim que a rodada é devolvida a quem voltou a conversar. `falhou`
  // entra porque `rodadaDeSilencio` precisa contá-las para não reabrir a
  // mesma rodada indefinidamente.
  const { data: feitos } = await supabase
    .from('crm_followups')
    .select('lead_id, tipo, status')
    .in('lead_id', leads.map(l => l.id))
    .in('status', ['pendente', 'enviado', 'falhou']);

  const porLead = new Map();
  for (const f of feitos || []) {
    if (!porLead.has(f.lead_id)) porLead.set(f.lead_id, []);
    porLead.get(f.lead_id).push(f);
  }

  // Conversa aberta e não assumida por humano. Conferir aqui, e não só no
  // envio, evita encher `crm_followups` de linhas que já nascem para falhar.
  const { data: conversas } = await supabase
    .from('wa_conversations')
    .select('contact_id, status')
    .in('contact_id', leads.map(l => l.contact_id))
    .eq('status', 'active');

  const comConversa = new Set((conversas || []).map(c => c.contact_id));

  const selecionados = [];
  const ignorados = {};
  let examinados = 0;

  for (const lead of leads) {
    if (selecionados.length >= lote) break;
    if (!comConversa.has(lead.contact_id)) continue;

    // Lixo de cadastro não vira agendamento. O worker confere de novo antes
    // de enviar — este gate existe para a linha nem nascer, e para o número
    // inválido não ocupar uma das 15 vagas do lote de quem é alcançável.
    if (String(lead.phone).startsWith('teste')) continue;
    if (!telefoneValido(lead.phone)) {
      logger.debug(`[followup] Lead ${lead.id} fora da varredura: telefone ${lead.phone}`);
      continue;
    }

    const tipo = rodadaDeSilencio(porLead.get(lead.id) || []);
    if (!tipo) continue;

    examinados++;

    const silencio = await estadoDoSilencio(lead.contact_id);
    if (!silencio) continue;
    if (silencio.desde.getTime() > agora - dias * DIA_MS) continue;

    // A pergunta cara fica por último de propósito: é a única que sai para
    // a rede, e só vale a pena para quem já passou por todo o resto.
    const situacao = await situacaoComercial(lead);
    if (situacao !== 'lead') {
      logger.info(`[followup] Lead ${lead.id} fora da varredura: ${situacao === 'aluno'
        ? 'é aluno com contrato ativo' : 'situação indefinida (EVO não respondeu)'}`);
      ignorados[situacao] = (ignorados[situacao] || 0) + 1;

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
      continue;
    }

    selecionados.push({
      lead_id: lead.id,
      nome: lead.full_name,
      etapa: lead.stage,
      tipo,
      dias_parado: silencio.dias,
      calado_desde: silencio.desde.toISOString(),
      ultima_fala_de: silencio.porQuem,
    });
  }

  // O escalonamento anda com um CURSOR, e não com `agora + i * intervalo`.
  //
  // A diferença aparece fora da janela: `dentroDaJanela` empurra tudo que
  // está antes das 9h para exatamente 9h00. Varredura rodando às 3h da
  // manhã — ou às 20h45, que cai no dia seguinte — marcaria as 15 cutucadas
  // no mesmo minuto, que é justamente o que o espaçamento existe para
  // evitar. Avançando o cursor e reajustando a cada passo, o escalonamento
  // sobrevive à virada: 20h31 vira 9h00 do dia seguinte, e o próximo, 9h07.
  //
  // Calculado antes do desvio de simulação de propósito: quem lê a prévia
  // precisa ver a que horas cada mensagem sairia, não só quem entraria.
  let cursor = dentroDaJanela(new Date(agora));
  for (const alvo of selecionados) {
    alvo.agendado_para = cursor.toISOString();
    cursor = dentroDaJanela(new Date(cursor.getTime() + intervaloMin * 60_000));
  }

  // A varredura SEMPRE diz o que fez, inclusive quando não fez nada.
  //
  // Antes ela só logava quando agendava algo, e o silêncio no log era
  // ambíguo de um jeito caro: "rodou e não achou ninguém" ficava idêntico a
  // "não rodou" — e as duas coisas exigem investigações opostas. Uma linha
  // por hora é barata; não saber se o worker está vivo, não.
  //
  // Os três números contam a história inteira: quantos leads da janela
  // foram olhados, quantos tinham rodada aberta, e quantos estavam mesmo
  // calados. `candidatos > 0` com `elegiveis = 0` é operação normal;
  // `candidatos = 0` é sinal de que o filtro ou a janela estão errados.
  const descartes = [
    ignorados.aluno ? `${ignorados.aluno} aluno(s) ativo(s)` : null,
    ignorados.indefinido ? `${ignorados.indefinido} sem resposta do EVO` : null,
  ].filter(Boolean).join(', ');

  const resumo =
    `${leads.length} candidato(s) na janela de ${janelaDias}d, ` +
    `${examinados} com rodada aberta, ${selecionados.length} em silêncio há ${dias}d ou mais` +
    (descartes ? ` (fora: ${descartes})` : '');

  if (simular) {
    logger.info(`[followup] Varredura (SIMULAÇÃO): ${resumo} — nada gravado`);
    return { agendados: 0, leads: selecionados, examinados, simulado: true };
  }

  let agendados = 0;
  for (const alvo of selecionados) {
    const criado = await agendar(alvo.lead_id, alvo.tipo, new Date(alvo.agendado_para), {
      origem: 'varredura_silencio',
      calado_desde: alvo.calado_desde,
      dias_parado: alvo.dias_parado,
      ultima_fala_de: alvo.ultima_fala_de,
    });
    if (criado) agendados++;
  }

  logger.info(`[followup] Varredura de silêncio: ${resumo} → ${agendados} agendada(s)`);
  return { agendados, leads: selecionados, examinados };
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
 * muda é só quem tem a palavra agora — e, no ciclo seguinte, a régua de
 * silêncio passa a enxergar o lead e faz o trabalho de sempre.
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
    .select('id, full_name, stage, contact_id')
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

    await registrarEvento(alvo.lead_id, {
      type: 'handoff_devolvido',
      actor: 'sistema',
      summary:
        `Cliente sem responder há ${alvo.dias_parado} dia(s) desde a última fala nossa — ` +
        'conversa devolvida à Leia para a régua de follow-up',
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
    // o painel mostra como "parado há" é `stage_since`, e esse não se
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
 * nela, e ela fica `pendente` para sempre. `rodadaDeSilencio` devolve
 * `null` diante de qualquer pendente — então essa linha órfã não é só
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
        evo_id_prospect, evo_id_member, experimental_at, experimental_activity
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
  JANELA, JANELAS, janelaDoDia, dentroDaJanela, horarioDoLembrete,
  TIPOS_SILENCIO, TIPOS_REGUA,
  agendar, cancelar, aoAgendarExperimental, proximaSondagem, varrerSilenciosos,
  retomarHandoffsMudos,
  vencidos, registrarEnvio, registrarTentativa, registrarNoFunil, situacaoComercial,
};
