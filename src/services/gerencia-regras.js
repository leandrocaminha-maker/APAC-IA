/**
 * src/services/gerencia-regras.js
 * As regras do painel gerencial: o que merece a atenção do gerente, quando
 * uma aula experimental vira aviso à coordenação, e o texto das mensagens.
 *
 * Puras: recebem os dados já lidos e devolvem decisões. Quem lê o banco e
 * manda WhatsApp é `gerencia.js`.
 *
 * ## Por que existe (29/10/2026)
 *
 * A verificação desse dia achou 289 atendimentos de venda abertos, 61% sem
 * mensagem havia mais de uma semana, e ninguém olhando: cliente que
 * escreveu e ficou sem resposta, aula vendida sem horário, aula feita sem
 * desfecho. O funil mostra etapa; o gerente precisa ver o que está parado
 * do NOSSO lado, e ser avisado sem ter de abrir o painel.
 */

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const OFFSET_SP_MS = -3 * HORA_MS;

// ──────────────────────────────────────────────
// Catálogos
// ──────────────────────────────────────────────

/**
 * As situações que pedem o gerente. A ordem é a da tela, a do quadro de
 * avisos e a da mensagem de WhatsApp. "Cliente sem resposta" fica abaixo
 * das aulas a pedido do responsável (29/10/2026): é o grupo mais longo, e
 * as aulas são as que têm data.
 */
export const TIPOS_ALERTA = {
  handoff_parado: {
    rotulo: 'Pedido de consultor sem dono',
    descricao: 'A Leia passou o atendimento para a equipe e ninguém assumiu.',
    limite: { campo: 'horas', rotulo: 'depois de (horas)', padrao: 2, min: 1, max: 72 },
    ativo: true,
  },
  aula_sem_reserva: {
    rotulo: 'Aula vendida sem horário',
    descricao: 'A aula experimental foi vendida no EVO e o horário não foi reservado (o sistema procura por 7 dias).',
    limite: { campo: 'horas', rotulo: 'depois de (horas)', padrao: 3, min: 1, max: 72 },
    ativo: true,
  },
  aula_sem_desfecho: {
    rotulo: 'Aula feita sem desfecho',
    descricao: 'A aula experimental já passou e o atendimento não virou venda nem perda.',
    limite: { campo: 'dias', rotulo: 'depois de (dias)', padrao: 3, min: 1, max: 30 },
    ativo: true,
  },
  cliente_sem_resposta: {
    rotulo: 'Cliente sem resposta',
    descricao: 'O cliente escreveu e ninguém respondeu. Cortesia ("ok", "obrigada", figurinha) não conta.',
    limite: { campo: 'horas', rotulo: 'depois de (horas)', padrao: 4, min: 1, max: 168 },
    ativo: true,
  },
  acao_vencida: {
    rotulo: 'Próxima ação vencida',
    descricao: 'A próxima ação combinada no lead passou da data.',
    limite: { campo: 'horas', rotulo: 'depois de (horas)', padrao: 24, min: 1, max: 168 },
    ativo: false,
  },
};

/** Quando uma aula experimental pode virar aviso. */
export const EVENTOS_AULA = {
  agendada: 'Quando a aula é marcada',
  vespera: 'Na véspera da aula',
  dia: 'No dia da aula (antes do horário)',
  sem_presenca: 'Sem presença registrada no dia seguinte',
  sem_desfecho: 'Aula feita e sem desfecho depois de N dias',
};

export const DESTINOS = {
  coordenacao: 'Coordenação',
  gerente: 'Gerente',
  ambos: 'Gerente e coordenação',
};

export const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Alerta mais velho que isto aparece no painel, mas não vira WhatsApp. */
export const AVISO_ATE_DIAS = 7;

/** Itens por mensagem — o resto fica no painel. */
export const ITENS_POR_MENSAGEM = 8;

export const CONFIG_PADRAO = {
  avisos: {
    ligado: false,
    gerente: [],
    coordenacao: [],
    horaInicio: '08:00',
    horaFim: '20:30',
  },
  alertas: Object.fromEntries(Object.entries(TIPOS_ALERTA).map(([tipo, t]) =>
    [tipo, { ativo: t.ativo, [t.limite.campo]: t.limite.padrao }])),
  aulas: {
    regras: [{
      id: 'todas',
      nome: 'Toda aula experimental',
      ativa: false,
      eventos: ['agendada', 'sem_presenca'],
      idadeMin: null,
      idadeMax: null,
      semIdade: true,
      atividades: [],
      diasSemana: [],
      destino: 'coordenacao',
      diasSemDesfecho: 3,
    }],
  },
};

// ──────────────────────────────────────────────
// Configuração
// ──────────────────────────────────────────────

const inteiro = (v, min, max, padrao) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
};
const hora = (v, padrao) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : padrao);
const texto = (v, max) => String(v ?? '').trim().slice(0, max);

/** Celular brasileiro com DDI, ou `null`. Aceita "(11) 98259-2538". */
export function telefoneDaEquipe(v) {
  const d = String(v || '').replace(/\D/g, '');
  const comDdi = d.length === 10 || d.length === 11 ? `55${d}` : d;
  return /^55\d{10,11}$/.test(comDdi) ? comDdi : null;
}

const telefones = (lista) => [...new Set((Array.isArray(lista) ? lista : String(lista || '').split(/[,;\n]/))
  .map(telefoneDaEquipe).filter(Boolean))].slice(0, 5);

function normalizarRegra(r, i) {
  const eventos = (Array.isArray(r?.eventos) ? r.eventos : []).filter(e => EVENTOS_AULA[e]);
  const idadeMin = r?.idadeMin === '' || r?.idadeMin == null ? null : inteiro(r.idadeMin, 0, 100, null);
  const idadeMax = r?.idadeMax === '' || r?.idadeMax == null ? null : inteiro(r.idadeMax, 0, 100, null);
  return {
    id: texto(r?.id, 40).replace(/[^\w-]/g, '') || `regra-${i + 1}`,
    nome: texto(r?.nome, 60) || `Regra ${i + 1}`,
    ativa: r?.ativa === true,
    eventos: eventos.length ? [...new Set(eventos)] : ['agendada'],
    idadeMin,
    idadeMax: idadeMin != null && idadeMax != null && idadeMax < idadeMin ? idadeMin : idadeMax,
    semIdade: r?.semIdade !== false,
    atividades: [...new Set((Array.isArray(r?.atividades) ? r.atividades : [])
      .map(a => texto(a, 60)).filter(Boolean))].slice(0, 20),
    diasSemana: [...new Set((Array.isArray(r?.diasSemana) ? r.diasSemana : [])
      .map(d => Number(d)).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort(),
    destino: DESTINOS[r?.destino] ? r.destino : 'coordenacao',
    diasSemDesfecho: inteiro(r?.diasSemDesfecho, 1, 30, 3),
  };
}

/**
 * A configuração gravada (ou vinda da tela), completa e dentro dos limites.
 * O que faltar vem do padrão; o que vier fora do lugar é corrigido, não
 * recusado — a tela é de quem não programa.
 */
export function normalizarConfig(entrada = {}) {
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const avisos = e.avisos || {};
  const alertas = {};
  for (const [tipo, t] of Object.entries(TIPOS_ALERTA)) {
    const a = e.alertas?.[tipo] || {};
    alertas[tipo] = {
      ativo: typeof a.ativo === 'boolean' ? a.ativo : t.ativo,
      [t.limite.campo]: inteiro(a[t.limite.campo], t.limite.min, t.limite.max, t.limite.padrao),
    };
  }
  const regras = Array.isArray(e.aulas?.regras) ? e.aulas.regras : CONFIG_PADRAO.aulas.regras;
  const ids = new Set();
  const normalizadas = regras.slice(0, 20).map(normalizarRegra).map((r, i) => {
    let id = r.id;
    while (ids.has(id)) id = `${r.id}-${i + 1}`;
    ids.add(id);
    return { ...r, id };
  });

  return {
    avisos: {
      ligado: avisos.ligado === true,
      gerente: telefones(avisos.gerente),
      coordenacao: telefones(avisos.coordenacao),
      horaInicio: hora(avisos.horaInicio, CONFIG_PADRAO.avisos.horaInicio),
      horaFim: hora(avisos.horaFim, CONFIG_PADRAO.avisos.horaFim),
    },
    alertas,
    aulas: { regras: normalizadas },
  };
}

// ──────────────────────────────────────────────
// Tempo e texto
// ──────────────────────────────────────────────

function partesSP(data) {
  const d = new Date(new Date(data).getTime() + OFFSET_SP_MS);
  return { dia: d.toISOString().slice(0, 10), minutos: d.getUTCHours() * 60 + d.getUTCMinutes(), semana: d.getUTCDay() };
}

/** `agora` cai entre `horaInicio` e `horaFim` (hora de São Paulo)? */
export function dentroDoHorario(agora, { horaInicio, horaFim }) {
  const m = partesSP(agora).minutos;
  const [hi, mi] = horaInicio.split(':').map(Number);
  const [hf, mf] = horaFim.split(':').map(Number);
  return m >= hi * 60 + mi && m <= hf * 60 + mf;
}

/** Idade em anos completos na data dada, ou `null` sem nascimento. */
export function idadeNaData(nascimento, data = new Date()) {
  if (!nascimento) return null;
  const [a, m, d] = String(nascimento).slice(0, 10).split('-').map(Number);
  if (!a || !m || !d) return null;
  const ref = partesSP(data).dia.split('-').map(Number);
  let idade = ref[0] - a;
  if (ref[1] < m || (ref[1] === m && ref[2] < d)) idade--;
  return idade >= 0 && idade < 120 ? idade : null;
}

export const normalizar = (t) => String(t || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const CORTESIA = /^(ok+|okay|blz|beleza|obrigad[ao]s?|obg|muito obrigad[ao]|valeu|vlw|ta bom|ta certo|combinado|certo|perfeito|show|top|joia|sim|ate|tchau|bom dia|boa tarde|boa noite|ok,? obrigad[ao]|obrigad[ao] pela informacao|obrigad[ao] pelas informacoes|\[mensagem nao suportada\])[\s!.,]*$/;

/** Mensagem que encerra sem pedir resposta: "ok", "obrigada", figurinha, emoji. */
export function ehCortesia(conteudo) {
  const t = normalizar(conteudo).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, '').trim();
  return t === '' || CORTESIA.test(t);
}

/** Data e hora curtas de São Paulo: "sáb 31/10, 10h30". */
export function quandoSP(iso) {
  const d = new Date(new Date(iso).getTime() + OFFSET_SP_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${DIAS_SEMANA[d.getUTCDay()]} ${dd}/${mm}, ${h}h${min}`;
}

/** "há 6h", "há 3 dias". */
export function haQuanto(iso, agora = new Date()) {
  const ms = agora.getTime() - new Date(iso).getTime();
  const h = Math.floor(ms / HORA_MS);
  if (h < 1) return `há ${Math.max(1, Math.floor(ms / 60000))} min`;
  if (h < 48) return `há ${h}h`;
  return `há ${Math.floor(ms / DIA_MS)} dias`;
}

export function telefoneLegivel(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(p || '');
}

// ──────────────────────────────────────────────
// Alertas
// ──────────────────────────────────────────────

const ABERTAS_COM_AULA = new Set(['experimental_agendada', 'experimental_realizada']);

/**
 * As situações que pedem o gerente, a partir dos atendimentos de venda
 * abertos já lidos.
 *
 * Cada lead traz: `id, full_name, phone, stage, stage_since, consultor,
 * experimental_at, experimental_activity, metadata, next_action_at,
 * next_action_note, conversa_status` e o resumo das mensagens —
 * `ultima: { quem, texto, em, id }` (quem: cliente | leia | consultor | followup)
 * e `ultimaNossaAntes` (quem falou nosso antes da última do cliente).
 *
 * A chave identifica o FATO (o lead e a mensagem, a aula, a venda), e é por
 * ela que o aviso não se repete.
 */
export function alertasDe(leads, config, agora = new Date()) {
  const cfg = normalizarConfig(config).alertas;
  const t = agora.getTime();
  const alertas = [];
  const base = (l) => ({
    leadId: l.id, nome: l.full_name || 'Sem nome', telefone: l.phone, consultor: l.consultor || null,
    etapa: l.stage,
  });

  for (const l of leads) {
    if (!/^55\d{10,11}$/.test(String(l.phone || ''))) continue;

    const u = l.ultima;
    if (cfg.cliente_sem_resposta.ativo && u?.quem === 'cliente' && !ehCortesia(u.texto)) {
      const espera = t - new Date(u.em).getTime();
      if (espera >= cfg.cliente_sem_resposta.horas * HORA_MS) {
        const deQuem = l.conversa_status === 'human' || l.ultimaNossaAntes === 'consultor' ? 'consultor' : 'leia';
        alertas.push({
          tipo: 'cliente_sem_resposta', chave: `csr:${l.id}:${u.id}`, ...base(l), desde: u.em,
          detalhe: u.texto, quemResponde: deQuem,
          gravidade: espera >= DIA_MS ? 'alta' : 'media',
        });
      }
    }

    if (cfg.handoff_parado.ativo && l.stage === 'aguardando_consultor') {
      const espera = t - new Date(l.stage_since).getTime();
      if (espera >= cfg.handoff_parado.horas * HORA_MS) {
        alertas.push({
          tipo: 'handoff_parado', chave: `hp:${l.id}:${l.stage_since}`, ...base(l), desde: l.stage_since,
          detalhe: u?.texto || '', gravidade: espera >= 8 * HORA_MS ? 'alta' : 'media',
        });
      }
    }

    const vendida = l.metadata?.aula_vendida;
    if (cfg.aula_sem_reserva.ativo && vendida?.vendida_em) {
      const espera = t - new Date(vendida.vendida_em).getTime();
      if (espera >= cfg.aula_sem_reserva.horas * HORA_MS) {
        alertas.push({
          tipo: 'aula_sem_reserva', chave: `asr:${l.id}:${vendida.vendida_em}`, ...base(l), desde: vendida.vendida_em,
          detalhe: 'Aula experimental vendida no EVO, sem horário reservado', gravidade: 'alta',
        });
      }
    }

    if (cfg.aula_sem_desfecho.ativo && ABERTAS_COM_AULA.has(l.stage) && l.experimental_at) {
      const depois = t - new Date(l.experimental_at).getTime();
      if (depois >= cfg.aula_sem_desfecho.dias * DIA_MS) {
        alertas.push({
          tipo: 'aula_sem_desfecho', chave: `asd:${l.id}:${l.experimental_at}`, ...base(l), desde: l.experimental_at,
          detalhe: `${l.experimental_activity || 'Aula experimental'} em ${quandoSP(l.experimental_at)}`,
          gravidade: depois >= 7 * DIA_MS ? 'alta' : 'media',
        });
      }
    }

    if (cfg.acao_vencida.ativo && l.next_action_at) {
      const atraso = t - new Date(l.next_action_at).getTime();
      if (atraso >= cfg.acao_vencida.horas * HORA_MS) {
        alertas.push({
          tipo: 'acao_vencida', chave: `av:${l.id}:${l.next_action_at}`, ...base(l), desde: l.next_action_at,
          detalhe: l.next_action_note || '', gravidade: atraso >= 3 * DIA_MS ? 'alta' : 'media',
        });
      }
    }
  }

  // Por tipo, e dentro do tipo o mais recente primeiro: é o que ainda dá
  // para salvar. O de semanas atrás é fila a limpar, não urgência.
  const ordem = Object.keys(TIPOS_ALERTA);
  return alertas.sort((a, b) => ordem.indexOf(a.tipo) - ordem.indexOf(b.tipo)
    || new Date(b.desde) - new Date(a.desde));
}

/**
 * Marca nos alertas as baixas dadas no painel. A baixa é do FATO (a
 * chave), não do lead: mensagem nova do cliente é chave nova, e o alerta
 * volta sozinho.
 */
export function aplicarBaixas(alertas, baixas = {}) {
  return alertas.map(a => (baixas[a.chave] ? { ...a, baixa: baixas[a.chave] } : a));
}

/** Chave de alerta aceitável para dar baixa: tipo curto, lead, e o resto do fato. */
export function chaveDeAlertaValida(chave) {
  return typeof chave === 'string' && chave.length <= 160 && /^[a-z]{2,4}:\d+:[\w:.+-]+$/.test(chave);
}

// ──────────────────────────────────────────────
// Aulas experimentais → coordenação
// ──────────────────────────────────────────────

/**
 * A regra vale para esta aula? `aula`: `{ idade, atividade, experimental_at }`.
 *
 *  - Idade: entre `idadeMin` e `idadeMax` (inclusive). Sem nascimento
 *    cadastrado, vale o `semIdade` da regra.
 *  - Atividade: alguma das escolhidas aparece no nome da atividade, sem
 *    acento nem caixa ("natação bebê" casa "Natação Bebê 1 e 2"). Nenhuma
 *    escolhida = todas.
 *  - Dia da semana da aula, se a regra escolheu algum.
 */
export function regraCasa(regra, aula) {
  if (!regra?.ativa) return false;

  const temFaixa = regra.idadeMin != null || regra.idadeMax != null;
  if (temFaixa) {
    if (aula.idade == null) {
      if (!regra.semIdade) return false;
    } else {
      if (regra.idadeMin != null && aula.idade < regra.idadeMin) return false;
      if (regra.idadeMax != null && aula.idade > regra.idadeMax) return false;
    }
  }

  if (regra.atividades?.length) {
    const nome = normalizar(aula.atividade);
    if (!regra.atividades.some(a => nome.includes(normalizar(a)))) return false;
  }

  if (regra.diasSemana?.length && aula.experimental_at) {
    if (!regra.diasSemana.includes(partesSP(aula.experimental_at).semana)) return false;
  }

  return true;
}

const ENCERRADAS = new Set(['ganho', 'perdido', 'finalizado']);

/**
 * Os eventos desta aula que estão valendo AGORA. Cada um sai uma vez (a
 * chave cuida disso); aqui só se decide se a janela dele está aberta.
 *
 *  - agendada: a aula ainda vai acontecer.
 *  - vespera: hoje é o dia anterior ao da aula.
 *  - dia: hoje é o dia da aula e ela ainda não começou.
 *  - sem_presenca: a partir das 9h do dia seguinte, por 3 dias, sem a
 *    presença que o EVO avisa ("realizada") e sem venda.
 *  - sem_desfecho: `diasSemDesfecho` depois da aula, por 3 dias, com o
 *    atendimento ainda aberto.
 */
export function eventosValendo(aula, agora = new Date(), { diasSemDesfecho = 3 } = {}) {
  if (!aula.experimental_at) return [];
  const t = agora.getTime();
  const quando = new Date(aula.experimental_at).getTime();
  const hoje = partesSP(agora).dia;
  const diaDaAula = partesSP(aula.experimental_at).dia;
  const vespera = partesSP(quando - DIA_MS).dia;
  const eventos = [];

  if (quando > t) {
    eventos.push('agendada');
    if (hoje === vespera) eventos.push('vespera');
    if (hoje === diaDaAula) eventos.push('dia');
    return eventos;
  }

  const diaSeguinte9h = new Date(`${partesSP(quando + DIA_MS).dia}T09:00:00-03:00`).getTime();
  if (t >= diaSeguinte9h && t < diaSeguinte9h + 3 * DIA_MS
    && aula.experimental_status !== 'realizada' && aula.stage !== 'ganho') {
    eventos.push('sem_presenca');
  }

  const prazo = quando + diasSemDesfecho * DIA_MS;
  if (t >= prazo && t < prazo + 3 * DIA_MS && !ENCERRADAS.has(aula.stage)) eventos.push('sem_desfecho');

  return eventos;
}

/**
 * Os avisos de aula devidos agora: para cada aula, cada regra ativa que
 * casa e cada evento da regra que está valendo.
 *
 * @returns {Array<{ chave, regra, evento, aula, destino }>}
 */
export function avisosDeAula(aulas, config, agora = new Date()) {
  const regras = normalizarConfig(config).aulas.regras.filter(r => r.ativa);
  const avisos = [];
  for (const aula of aulas) {
    for (const regra of regras) {
      if (!regraCasa(regra, aula)) continue;
      const valendo = eventosValendo(aula, agora, { diasSemDesfecho: regra.diasSemDesfecho });
      for (const evento of regra.eventos.filter(e => valendo.includes(e))) {
        avisos.push({
          chave: `aula:${aula.leadId}:${aula.experimental_at}:${evento}:${regra.id}`,
          regra: { id: regra.id, nome: regra.nome }, evento, aula, destino: regra.destino,
        });
      }
    }
  }
  return avisos;
}

/** As regras ativas que casam com a aula — para a tela mostrar "quem será avisado". */
export function regrasQueCasam(aula, config) {
  return normalizarConfig(config).aulas.regras.filter(r => regraCasa(r, aula)).map(r => r.nome);
}

// ──────────────────────────────────────────────
// Mensagens
// ──────────────────────────────────────────────

const ROTULO_EVENTO = {
  agendada: '🗓️ Aula experimental marcada',
  vespera: '⏰ Aula experimental amanhã',
  dia: '📍 Aula experimental hoje',
  sem_presenca: '❔ Aula sem presença registrada',
  sem_desfecho: '📌 Aula feita, sem desfecho',
};

function linhaDaAula(aviso) {
  const a = aviso.aula;
  const idade = a.idade != null ? ` (${a.idade} ${a.idade === 1 ? 'ano' : 'anos'})` : '';
  return [
    `${ROTULO_EVENTO[aviso.evento]}`,
    `*${a.nome}*${idade}`,
    `${a.atividade || 'Atividade não informada'} — ${quandoSP(a.experimental_at)}`,
    `Contato: ${telefoneLegivel(a.telefone)}${a.consultor ? ` · ${a.consultor}` : ''}`,
    `_Regra: ${aviso.regra.nome}_`,
  ].join('\n');
}

const ROTULO_QUEM = { consultor: 'consultor', leia: 'Leia não respondeu' };

function linhaDoAlerta(a, agora) {
  const quem = a.tipo === 'cliente_sem_resposta' ? ` · ${ROTULO_QUEM[a.quemResponde]}` : '';
  const detalhe = a.detalhe ? `\n   "${String(a.detalhe).replace(/\s+/g, ' ').slice(0, 90)}"` : '';
  return `• *${a.nome}* ${telefoneLegivel(a.telefone)} — ${haQuanto(a.desde, agora)}` +
    `${a.consultor ? ` · ${a.consultor}` : ''}${quem}${detalhe}`;
}

/**
 * A mensagem de um ciclo para uma pessoa: alertas agrupados por tipo e
 * avisos de aula, no máximo `ITENS_POR_MENSAGEM` itens. Sem nada, `null`.
 */
export function mensagemDoCiclo({ alertas = [], aulas = [], link = '' }, agora = new Date()) {
  const itens = alertas.length + aulas.length;
  if (!itens) return null;

  const partes = [`*Painel gerencial — AP Academia*\n${itens} ${itens === 1 ? 'situação nova' : 'situações novas'}`];
  let usados = 0;

  for (const [tipo, t] of Object.entries(TIPOS_ALERTA)) {
    const doTipo = alertas.filter(a => a.tipo === tipo);
    if (!doTipo.length || usados >= ITENS_POR_MENSAGEM) continue;
    const cabem = doTipo.slice(0, ITENS_POR_MENSAGEM - usados);
    usados += cabem.length;
    partes.push(`*${t.rotulo}* (${doTipo.length})\n${cabem.map(a => linhaDoAlerta(a, agora)).join('\n')}`);
  }

  for (const aviso of aulas) {
    if (usados >= ITENS_POR_MENSAGEM) break;
    usados++;
    partes.push(linhaDaAula(aviso));
  }

  if (itens > usados) partes.push(`…e mais ${itens - usados} no painel.`);
  if (link) partes.push(link);
  return partes.join('\n\n');
}
