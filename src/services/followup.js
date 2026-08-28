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
import { registrarEvento } from './funil.js';
// Sem ciclo: `evolution.js` só importa config e logger.
import { telefoneValido } from './evolution.js';

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
 * Agenda um follow-up.
 *
 * Idempotente pela UNIQUE parcial `(lead_id, tipo) WHERE pendente`: chamar
 * duas vezes não gera duas cobranças. Reagendamento explícito atualiza a
 * data em vez de duplicar.
 */
export async function agendar(leadId, tipo, quando, contexto = {}) {
  const alvo = dentroDaJanela(quando instanceof Date ? quando : new Date(quando));

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
    .select('id, full_name, phone, stage, contact_id, last_activity_at')
    .not('stage', 'in', '(ganho,perdido)')
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
  const resumo =
    `${leads.length} candidato(s) na janela de ${janelaDias}d, ` +
    `${examinados} com rodada aberta, ${selecionados.length} em silêncio há ${dias}d ou mais`;

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

/** Follow-ups vencidos, prontos para envio. */
export async function vencidos(limite = 20) {
  const { data, error } = await supabase
    .from('crm_followups')
    .select(`
      id, tipo, scheduled_for, contexto, tentativas,
      lead:crm_leads (
        id, full_name, phone, stage, contact_id, interest,
        evo_id_prospect, evo_id_member, experimental_at, experimental_activity
      )
    `)
    .eq('status', 'pendente')
    .lte('scheduled_for', new Date().toISOString())
    .lt('tentativas', 3)
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
  await supabase
    .from('crm_followups')
    .update({ tentativas: tentativas + 1, erro: String(erro).slice(0, 400) })
    .eq('id', followupId);
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
  JANELA, JANELAS, janelaDoDia, dentroDaJanela, horarioDoLembrete, TIPOS_SILENCIO,
  agendar, cancelar, aoAgendarExperimental, proximaSondagem, varrerSilenciosos,
  vencidos, registrarEnvio, registrarTentativa, registrarNoFunil,
};
