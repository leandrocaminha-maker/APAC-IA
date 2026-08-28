/**
 * src/services/campanhas.js
 * Campanha ativa: alvos, supressão e a regulagem de disparo.
 *
 * ## O que este arquivo NÃO faz
 *
 * Não envia. Quem envia é o `queue-processor`, que já existia e já tem
 * retry, rate limit e gravação no histórico. Aqui se decide **quando** cada
 * mensagem deve sair, e isso vira uma linha em `wa_message_queue` com
 * `scheduled_for` no futuro.
 *
 * Essa separação é o desenho, não uma conveniência: como não existe caminho
 * daqui até a Evolution, não existe caminho para um disparo em rajada. O
 * pior que um erro de código aqui pode fazer é agendar demais para o mesmo
 * minuto — e o teto diário, que é conferido antes de agendar, limita
 * inclusive isso.
 *
 * ## A regulagem
 *
 * `distribuirHorarios()` é o coração. Ela pega N mensagens e espalha pelo
 * que sobra da janela de hoje, com folga aleatória entre elas. Vinte
 * mensagens em 9h–20h30 dão uma a cada ~34 minutos. Não é lentidão por
 * cautela vaga: cadência regular e apertada é o que distingue robô de
 * pessoa para quem analisa o comportamento do número.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { dentroDaJanela, janelaDoDia } from './followup.js';
import { montarSegmento } from './segmentos.js';
import { normalizePhone, telefoneValido } from './evolution.js';

// As constantes espelhadas saíram em 28/08/2026, quando a janela deixou de
// ser 9h–20h30 todo dia: sábado fecha às 13h e domingo não tem contato.
// Espelho de regra que muda vira divergência — a campanha espalharia até
// 20h30 num sábado e `dentroDaJanela` empurraria o excedente todo para as
// 9h de segunda, amontoando na abertura justamente o que o espalhamento
// existe para evitar. Agora a janela do dia vem de `janelaDoDia`.

const TIMEZONE = 'America/Sao_Paulo';

/** Partes da data no fuso de São Paulo. O container roda em UTC. */
function partesSP(data = new Date()) {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(data);
  const pega = (t) => Number(fmt.find(p => p.type === t)?.value ?? 0);
  return { hora: pega('hour'), minuto: pega('minute') };
}

/** Data de hoje em São Paulo, como 'AAAA-MM-DD'. */
export function hojeSP(data = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(data);
}

// ──────────────────────────────────────────────
// Supressão
// ──────────────────────────────────────────────

/**
 * Frases que significam "pare de me mandar mensagem".
 *
 * A lista é curta e ancorada no INÍCIO da mensagem de propósito. "Não
 * quero" solto pega "não quero musculação, quero natação", que é uma
 * objeção de venda e não um pedido de descadastro — suprimir essa pessoa
 * seria perder um lead por erro de leitura.
 */
const PEDIDOS_DE_SAIDA = [
  /^sair$/, /^sair (da|do) (lista|cadastro|grupo)/,
  // "parar" e "pare" exigem a forma verbal COMPLETA, e "para" só vale
  // sozinho.
  //
  // A versão anterior era /^parar?\b/, que parecia inofensiva e casava com
  // a PREPOSIÇÃO: "Para mim", "Para minha filha", "para academia" — tudo
  // virava pedido de descadastro. Aconteceu duas vezes em 25/08/2026, com
  // gente da campanha.
  //
  // E o pior: "Para mim" é a resposta à pergunta que a própria Leia faz na
  // qualificação ("é para você ou está pesquisando para outra pessoa?"). O
  // roteiro de vendas provocava a própria supressão do lead.
  /^parar\b/, /^pare\b/, /^para$/,
  /^stop\b/, /^cancelar? inscri/,
  /^descadastr/, /^remover? (meu|me d|da lista)/,
  /^me (tira|remove|descadastr)/,
  /^n[aã]o (quero|desejo) (mais )?receber/, /^para de (me )?mandar/,
  /^n[aã]o me (mande|envie|perturbe)/,
];

/** Normaliza para comparação: sem acento, minúsculo, sem pontuação nas bordas. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
}

/**
 * A mensagem é um pedido para sair da lista?
 *
 * Só olha mensagens curtas. Quem escreve um parágrafo está conversando, e
 * "parar" no meio de uma frase longa quase nunca é descadastro — mas
 * "PARAR" sozinho sempre é.
 *
 * @param {string} texto
 * @returns {boolean}
 */
export function ehPedidoDeSaida(texto) {
  const limpo = normalizar(texto);
  if (!limpo || limpo.length > 60) return false;
  return PEDIDOS_DE_SAIDA.some(re => re.test(limpo));
}

/**
 * Registra a supressão e desfaz o que já estava a caminho.
 *
 * As duas metades importam. Só gravar na lista deixaria sair a mensagem
 * que já estava agendada em `wa_message_queue` — e receber mais uma
 * mensagem DEPOIS de pedir para sair é o que transforma um pedido em
 * denúncia.
 *
 * @param {string} phone
 * @param {object} [opts]
 * @param {string} [opts.motivo]
 * @param {string} [opts.origem]
 * @param {string} [opts.detalhe] - O que a pessoa escreveu.
 * @returns {Promise<{novo:boolean, canceladas:number}>}
 */
export async function suprimir(phone, { motivo = 'pediu_para_sair', origem = 'whatsapp', detalhe = null } = {}) {
  const numero = normalizePhone(phone);

  const { error } = await supabase
    .from('crm_supressoes')
    .insert({ phone: numero, motivo, origem, detalhe: detalhe?.slice(0, 500) ?? null });

  const novo = !error;
  if (error && error.code !== '23505') {
    logger.error('[campanhas] Falha ao gravar supressão:', error.message);
  }

  // Apaga o que ainda não saiu. `delete` e não update: a fila é transporte,
  // e o razão de quem recebeu o quê é `crm_campanha_alvos`.
  const { data: apagadas } = await supabase
    .from('wa_message_queue')
    .delete()
    .eq('phone', numero)
    .eq('status', 'pending')
    .select('id');

  const canceladas = apagadas?.length ?? 0;

  await supabase
    .from('crm_campanha_alvos')
    .update({ status: 'suprimido', queue_id: null, scheduled_for: null })
    .eq('phone', numero)
    .in('status', ['pendente', 'agendado']);

  logger.info(
    `[campanhas] Supressão de ${numero} (${motivo})` +
    `${canceladas ? ` — ${canceladas} mensagem(ns) agendada(s) cancelada(s)` : ''}`
  );

  return { novo, canceladas };
}

/** Está na lista de supressão? */
export async function estaSuprimido(phone) {
  const { data } = await supabase
    .from('crm_supressoes')
    .select('id')
    .eq('phone', normalizePhone(phone))
    .maybeSingle();
  return Boolean(data);
}

/**
 * Telefones em carência: receberam campanha há pouco e não responderam.
 *
 * Distinto de supressão, e a diferença não é de grau. Supressão é a pessoa
 * pedindo para sair, e é permanente. Carência é o silêncio dela, que não
 * quer dizer recusa — quer dizer "agora não". Tratar os dois igual perderia
 * público de verdade; ignorar o segundo transforma oferta em perseguição.
 *
 * O filtro é `status = 'enviado'` porque os status dos alvos são exclusivos:
 * quem respondeu virou `respondeu` e sai desta conta sozinho. Ou seja, a
 * consulta já significa exatamente "recebeu e ficou calado".
 */
async function emCarencia(telefones, dias = config.campanha.carenciaDias) {
  if (!telefones.length || dias <= 0) return new Set();

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('crm_campanha_alvos')
    .select('phone')
    .in('phone', telefones)
    .eq('status', 'enviado')
    .gte('sent_at', desde);

  if (error) {
    logger.error('[campanhas] Falha ao conferir carência:', error.message);
    return new Set();
  }
  return new Set((data ?? []).map(r => r.phone));
}

/** Telefones suprimidos, dentro de uma lista. Uma consulta em vez de N. */
async function suprimidosEntre(telefones) {
  if (!telefones.length) return new Set();
  const { data } = await supabase
    .from('crm_supressoes')
    .select('phone')
    .in('phone', telefones);
  return new Set((data ?? []).map(r => r.phone));
}

// ──────────────────────────────────────────────
// Alvos
// ──────────────────────────────────────────────

/**
 * Monta a coorte do segmento e grava os alvos da campanha.
 *
 * Idempotente pela UNIQUE `(campanha_id, phone)`: rodar duas vezes não
 * duplica ninguém, e quem já foi contatado não volta para 'pendente'.
 *
 * @param {number} campanhaId
 * @returns {Promise<{inseridos:number, jaExistiam:number, suprimidos:number, total:number}>}
 */
export async function montarAlvos(campanhaId) {
  const campanha = await buscarCampanha(campanhaId);
  if (!campanha) throw new Error(`Campanha ${campanhaId} não encontrada`);

  const lista = await montarSegmento(campanha.segmento, campanha.segmento_args ?? {});
  if (!lista.length) return { inseridos: 0, jaExistiam: 0, suprimidos: 0, total: 0 };

  // Quem já pediu para sair nem entra como alvo — não é filtro de envio, é
  // filtro de entrada. Assim a pessoa não aparece nas contagens da campanha
  // como se fosse público dela.
  const suprimidos = await suprimidosEntre(lista.map(l => l.phone));

  // Carência pelo mesmo motivo da supressão: é filtro de ENTRADA, não de
  // envio. Quem está em carência não deve nem aparecer nas contagens desta
  // campanha, senão a taxa de resposta passa a ter no denominador gente que
  // nunca teve chance de responder.
  const carencia = await emCarencia(lista.map(l => l.phone));

  const elegiveis = lista.filter(l => !suprimidos.has(l.phone) && !carencia.has(l.phone));

  const linhas = elegiveis.map(l => ({
    campanha_id: campanhaId,
    phone: l.phone,
    nome: l.nome,
    evo_id_member: l.evo_id_member,
    evo_id_prospect: l.evo_id_prospect,
    contexto: l.contexto,
    status: 'pendente',
  }));

  let inseridos = 0;
  // Em lotes: um insert de 500 linhas estoura o limite de payload do PostgREST.
  for (let i = 0; i < linhas.length; i += 100) {
    const lote = linhas.slice(i, i + 100);
    const { data, error } = await supabase
      .from('crm_campanha_alvos')
      .upsert(lote, { onConflict: 'campanha_id,phone', ignoreDuplicates: true })
      .select('id');

    if (error) {
      logger.error('[campanhas] Falha ao gravar alvos:', error.message);
      continue;
    }
    inseridos += data?.length ?? 0;
  }

  const resultado = {
    inseridos,
    jaExistiam: elegiveis.length - inseridos,
    suprimidos: suprimidos.size,
    emCarencia: carencia.size,
    total: lista.length,
  };
  logger.info(`[campanhas] Alvos de "${campanha.slug}": ${JSON.stringify(resultado)}`);
  return resultado;
}

/**
 * Marca que a pessoa respondeu, encerrando a campanha para ela.
 *
 * Chamado quando chega mensagem de entrada. Quem respondeu vira conversa
 * normal — é para isso que a Leia existe — e continuar mandando campanha
 * por cima de uma conversa em andamento seria falar duas vezes ao mesmo
 * tempo.
 *
 * @param {string} phone
 * @returns {Promise<number>} Quantos alvos foram encerrados.
 */
export async function registrarResposta(phone) {
  const numero = normalizePhone(phone);

  const { data } = await supabase
    .from('crm_campanha_alvos')
    .update({ status: 'respondeu', replied_at: new Date().toISOString() })
    .eq('phone', numero)
    .in('status', ['agendado', 'enviado'])
    .select('id, campanha_id');

  const n = data?.length ?? 0;
  if (n) logger.info(`[campanhas] ${numero} respondeu — ${n} alvo(s) encerrado(s)`);
  return n;
}

// ──────────────────────────────────────────────
// Regulagem de disparo
// ──────────────────────────────────────────────

/**
 * Espalha N horários pelo que sobra da janela de contato de hoje.
 *
 * O intervalo base é o tempo restante dividido pela quantidade; cada
 * horário recebe uma folga aleatória de ±`jitter` sobre isso. Sem o jitter
 * a régua seria perfeita — 34, 68, 102 minutos — e cadência perfeita é
 * assinatura de automação.
 *
 * Devolve menos horários que o pedido quando o dia não cabe: o resto fica
 * `pendente` e o worker retoma amanhã. É por isso que o teto diário é um
 * teto e não uma meta.
 *
 * @param {number} quantidade
 * @param {object} [opts]
 * @param {Date} [opts.agora]
 * @param {number} [opts.intervaloMinimoMin] - Piso entre duas mensagens. Oito
 *   minutos, e não menos: quando a janela está acabando, o piso é o que
 *   decide se o resto do teto vira uma rajada agora ou espera amanhã. Com 3
 *   minutos, ativar uma campanha às 19h45 produzia 14 mensagens em 45
 *   minutos — o padrão que se está tentando evitar. Com 8, cabem 5 e o
 *   resto fica para o dia seguinte.
 * @param {number} [opts.jitter] - Fração de variação (0.4 = ±40%).
 * @returns {Date[]} Em ordem crescente, todos dentro da janela.
 */
export function distribuirHorarios(quantidade, { agora = new Date(), intervaloMinimoMin = 8, jitter = 0.4 } = {}) {
  if (quantidade <= 0) return [];

  // Domingo não tem contato, e sábado fecha às 13h: a janela é a do dia.
  const janela = janelaDoDia(agora);
  if (!janela) return [];

  const { hora, minuto } = partesSP(agora);
  const agoraMin = hora * 60 + minuto;

  // Antes da janela: começa na abertura. Depois dela: nada hoje.
  const inicioMin = Math.max(agoraMin, janela.inicioMin);
  if (inicioMin >= janela.fimMin) return [];

  const restanteMin = janela.fimMin - inicioMin;
  const intervaloBase = Math.max(intervaloMinimoMin, restanteMin / quantidade);

  const horarios = [];
  let deslocamento = 0;

  for (let i = 0; i < quantidade; i++) {
    // A primeira não sai imediatamente: um minuto de folga evita que uma
    // remontagem de alvos vire uma saraivada no mesmo instante.
    const variacao = 1 + (Math.random() * 2 - 1) * jitter;
    deslocamento += Math.max(intervaloMinimoMin, intervaloBase * variacao);

    const minutoAlvo = inicioMin + deslocamento;
    if (minutoAlvo >= janela.fimMin) break;

    const quando = new Date(agora.getTime() + (minutoAlvo - agoraMin) * 60_000);
    horarios.push(quando);
  }

  return horarios;
}

/**
 * Quantas mensagens desta campanha já saíram hoje.
 *
 * Conta 'agendado' junto com 'enviado': o que está agendado para hoje já
 * consumiu o teto, mesmo sem ter saído ainda. Contar só o enviado faria o
 * worker reagendar por cima do próprio agendamento a cada ciclo de 10
 * minutos, e o teto viraria decoração.
 */
export async function enviadosHoje(campanhaId) {
  const inicioDoDia = new Date(`${hojeSP()}T00:00:00-03:00`).toISOString();

  const { count } = await supabase
    .from('crm_campanha_alvos')
    .select('*', { count: 'exact', head: true })
    .eq('campanha_id', campanhaId)
    .in('status', ['agendado', 'enviado', 'respondeu'])
    .gte('scheduled_for', inicioDoDia);

  return count ?? 0;
}

/**
 * Enfileira uma mensagem já gerada.
 *
 * O `source_app` carrega o slug da campanha: é o que faz a mensagem
 * aparecer no histórico como `app:campanha:<slug>` e permite separar, meses
 * depois, o que foi atendimento do que foi prospecção.
 *
 * @returns {Promise<number|null>} id da linha na fila
 */
async function enfileirar({ phone, texto, quando, slug }) {
  const { data, error } = await supabase
    .from('wa_message_queue')
    .insert({
      phone,
      content: texto,
      content_type: 'text',
      source_app: `campanha:${slug}`,
      scheduled_for: quando.toISOString(),
      status: 'pending',
    })
    .select('id')
    .single();

  if (error) {
    logger.error('[campanhas] Falha ao enfileirar:', error.message);
    return null;
  }
  return data.id;
}

/**
 * Confere a guarda de supressão e pausa a campanha se ela estourou.
 *
 * É a realimentação que protege o número: se a lista estava errada, quem
 * avisa são as próprias pessoas, e a campanha para antes de a conta do
 * WhatsApp reagir. Sem isto o sinal só chegaria como bloqueio.
 *
 * @returns {Promise<boolean>} true se pausou agora
 */
export async function conferirGuarda(campanha) {
  const { data } = await supabase
    .from('crm_campanhas_resumo')
    .select('enviados, responderam, suprimidos, taxa_supressao')
    .eq('id', campanha.id)
    .single();

  if (!data) return false;

  const avaliados = (data.enviados ?? 0) + (data.responderam ?? 0) + (data.suprimidos ?? 0);
  if (avaliados < campanha.minimo_para_avaliar) return false;

  const taxa = Number(data.taxa_supressao ?? 0);
  if (taxa <= Number(campanha.limiar_supressao)) return false;

  const motivo =
    `Pausada automaticamente: ${(taxa * 100).toFixed(1)}% de supressão em ${avaliados} ` +
    `contatos, acima do limiar de ${(Number(campanha.limiar_supressao) * 100).toFixed(1)}%.`;

  await supabase
    .from('crm_campanhas')
    .update({ status: 'pausada', pausada_motivo: motivo })
    .eq('id', campanha.id);

  logger.warn(`[campanhas] "${campanha.slug}" — ${motivo}`);
  return true;
}

/**
 * Um ciclo de uma campanha: decide quantas cabem hoje, gera e agenda.
 *
 * @param {object} campanha
 * @param {(alvo:object, campanha:object) => Promise<string>} gerarTexto
 * @returns {Promise<{agendados:number, motivo?:string}>}
 */
export async function processarCampanha(campanha, gerarTexto) {
  if (await conferirGuarda(campanha)) {
    return { agendados: 0, motivo: 'guarda de supressão' };
  }

  const janelaHoje = janelaDoDia(new Date());
  if (!janelaHoje) {
    return { agendados: 0, motivo: 'domingo — sem contato ativo' };
  }

  const { hora, minuto } = partesSP();
  const agoraMin = hora * 60 + minuto;
  if (agoraMin >= janelaHoje.fimMin) {
    return { agendados: 0, motivo: 'fora da janela de contato' };
  }

  const jaHoje = await enviadosHoje(campanha.id);
  const restante = campanha.teto_diario - jaHoje;
  if (restante <= 0) {
    return { agendados: 0, motivo: `teto diário de ${campanha.teto_diario} atingido` };
  }

  const { data: alvos } = await supabase
    .from('crm_campanha_alvos')
    .select('*')
    .eq('campanha_id', campanha.id)
    .eq('status', 'pendente')
    .order('id', { ascending: true })
    .limit(restante);

  if (!alvos?.length) {
    // Sem pendente e sem agendado: a campanha cumpriu o que tinha.
    const { count } = await supabase
      .from('crm_campanha_alvos')
      .select('*', { count: 'exact', head: true })
      .eq('campanha_id', campanha.id)
      .in('status', ['pendente', 'agendado']);

    if (!count) {
      await supabase.from('crm_campanhas').update({ status: 'concluida' }).eq('id', campanha.id);
      logger.info(`[campanhas] "${campanha.slug}" concluída`);
    }
    return { agendados: 0, motivo: 'sem alvos pendentes' };
  }

  // Reconfere a supressão agora, não na montagem: a coorte é um retrato
  // datado, e alguém pode ter pedido para sair no intervalo.
  const suprimidos = await suprimidosEntre(alvos.map(a => a.phone));
  const elegiveis = alvos.filter(a => !suprimidos.has(a.phone));

  if (suprimidos.size) {
    await supabase
      .from('crm_campanha_alvos')
      .update({ status: 'suprimido' })
      .eq('campanha_id', campanha.id)
      .in('phone', [...suprimidos]);
  }

  if (!elegiveis.length) return { agendados: 0, motivo: 'todos os pendentes estão suprimidos' };

  const horarios = distribuirHorarios(elegiveis.length);
  let agendados = 0;

  for (let i = 0; i < horarios.length; i++) {
    const alvo = elegiveis[i];
    const quando = dentroDaJanela(horarios[i]);

    try {
      const texto = await gerarTexto(alvo, campanha);
      if (!texto?.trim()) {
        await marcarErro(alvo.id, 'o gerador não produziu texto');
        continue;
      }

      if (config.campanha.dryRun) {
        logger.info(
          `[campanhas] ENSAIO ${campanha.slug} → ${alvo.phone} ` +
          `(${quando.toISOString()}): ${texto.replace(/\n/g, ' | ')}`
        );
        // Marca 'agendado' mesmo em ensaio, com `queue_id` nulo.
        //
        // Deixá-lo 'pendente' parecia mais honesto e era um ralo: o alvo
        // não entraria na conta de `enviadosHoje`, o teto nunca seria
        // atingido, e a cada 10 minutos o worker geraria o texto de novo
        // para a mesma pessoa — gastando crédito de API para sempre, sem
        // nunca convergir.
        //
        // `queue_id` nulo é o que distingue ensaio de envio real, e é por
        // ele que o `reset` do scripts/campanha.js sabe o que pode voltar
        // para 'pendente'.
        await supabase
          .from('crm_campanha_alvos')
          .update({
            status: 'agendado',
            etapa_conversa: 'aguardando_consentimento',
            mensagem: texto,
            queue_id: null,
            scheduled_for: quando.toISOString(),
          })
          .eq('id', alvo.id);
        agendados++;
        continue;
      }

      const queueId = await enfileirar({
        phone: alvo.phone, texto, quando, slug: campanha.slug,
      });
      if (!queueId) {
        await marcarErro(alvo.id, 'falha ao enfileirar');
        continue;
      }

      await supabase
        .from('crm_campanha_alvos')
        .update({
          status: 'agendado',
          // A abertura só pede licença. Daqui até a resposta, esta pessoa
          // está na porta de consentimento: um "sim" ou "não" curto é
          // resolvido sem acordar o agente completo.
          etapa_conversa: 'aguardando_consentimento',
          mensagem: texto,
          queue_id: queueId,
          scheduled_for: quando.toISOString(),
        })
        .eq('id', alvo.id);

      agendados++;
    } catch (err) {
      logger.error(`[campanhas] Alvo ${alvo.id} falhou:`, err.message);
      await marcarErro(alvo.id, err.message?.slice(0, 300));
    }
  }

  if (agendados) {
    const primeiro = horarios[0];
    const ultimo = horarios[Math.min(agendados, horarios.length) - 1];
    logger.info(
      `[campanhas] "${campanha.slug}": ${agendados} agendada(s) entre ` +
      `${primeiro?.toISOString()} e ${ultimo?.toISOString()}` +
      `${config.campanha.dryRun ? ' (ENSAIO — nada foi enfileirado)' : ''}`
    );
  }

  return { agendados };
}

async function marcarErro(alvoId, erro) {
  await supabase
    .from('crm_campanha_alvos')
    .update({ status: 'erro', erro })
    .eq('id', alvoId);
}


/**
 * Marca como `enviado` os alvos cuja mensagem a fila já entregou.
 *
 * Nada fazia isso. `campanhas.js` agenda e o `queue-processor` envia, e os
 * dois não se conhecem — de propósito, porque é essa separação que impede
 * um disparo em rajada. O preço é que o alvo ficava eternamente
 * "agendado", e `enviados`, `taxa_resposta` e `taxa_supressao` na view
 * nunca saíam do zero. Ou seja: a campanha rodaria sem medição, que é a
 * única coisa que autoriza escalá-la.
 *
 * A reconciliação é por `queue_id`: se a linha da fila sumiu (o
 * queue-processor apaga? não — ele marca 'sent'), lê-se o status dela.
 *
 * @returns {Promise<number>} quantos foram reconciliados
 */
export async function reconciliarEnviados() {
  const { data: alvos } = await supabase
    .from('crm_campanha_alvos')
    .select('id, queue_id')
    .eq('status', 'agendado')
    .not('queue_id', 'is', null)
    .limit(200);

  if (!alvos?.length) return 0;

  const { data: filas } = await supabase
    .from('wa_message_queue')
    .select('id, status, processed_at')
    .in('id', alvos.map(a => a.queue_id));

  const porId = new Map((filas ?? []).map(f => [f.id, f]));
  let n = 0;

  for (const alvo of alvos) {
    const fila = porId.get(alvo.queue_id);
    if (!fila) continue;

    if (fila.status === 'sent') {
      await supabase
        .from('crm_campanha_alvos')
        .update({ status: 'enviado', sent_at: fila.processed_at ?? new Date().toISOString() })
        .eq('id', alvo.id);
      n++;
    } else if (fila.status === 'failed') {
      await supabase
        .from('crm_campanha_alvos')
        .update({ status: 'erro', erro: 'a fila não conseguiu entregar' })
        .eq('id', alvo.id);
      n++;
    }
  }

  if (n) logger.info(`[campanhas] ${n} alvo(s) reconciliado(s) com a fila`);
  return n;
}

// ──────────────────────────────────────────────
// Segmento vindo do EVO (crm.segmentation.batch)
// ──────────────────────────────────────────────

/**
 * Absorve um evento de segmentação do CRM do EVO.
 *
 * A automação do EVO dispara **um POST por pessoa** — o primeiro lote real
 * trouxe 47 em 2,6 segundos. Cada um vira um alvo `pendente`; nada sai daí
 * por chegar, porque quem decide o envio é a regulagem, com o teto diário.
 *
 * **O `eventType` não identifica o segmento.** É sempre
 * `crm.segmentation.batch`, para qualquer segmento que se monte na tela do
 * EVO. Quem distingue é o texto de `communication.message`, que é a
 * descrição escrita por uma pessoa — e é por ele que se acha a campanha.
 * Renomear o segmento no EVO quebra o vínculo, então a convenção é começar
 * a descrição com um código entre colchetes.
 *
 * ⚠️ `communication.message` **não é mensagem para o cliente**. No lote real
 * veio "alunos inativos que tinham contrato aqua que venceu entre jul e dez
 * de 2025" — o filtro, não um texto. Enviá-lo seria mandar a descrição do
 * segmento para as 47 pessoas.
 *
 * @param {object} payload - Corpo cru do webhook
 * @returns {Promise<{ok:boolean, motivo?:string, alvoId?:number}>}
 */
export async function absorverSegmentacao(payload) {
  const descricao = payload?.communication?.message?.trim();
  const pessoa = payload?.person ?? {};

  if (!descricao) return { ok: false, motivo: 'evento sem descrição de segmento' };

  const { data: campanha } = await supabase
    .from('crm_campanhas')
    .select('*')
    .eq('evento_gatilho', descricao)
    .maybeSingle();

  if (!campanha) {
    return { ok: false, motivo: `nenhuma campanha com evento_gatilho "${descricao.slice(0, 60)}"` };
  }

  const phone = telefoneValido(pessoa.phone);
  if (!phone) return { ok: false, motivo: `telefone inutilizável (${pessoa.phone ?? 'ausente'})` };

  if (await estaSuprimido(phone)) {
    return { ok: false, motivo: 'telefone na lista de supressão' };
  }

  // A carência vale nos DOIS caminhos de entrada. Aplicá-la só em
  // `montarAlvos` deixaria o portão aberto justamente por onde a coorte real
  // entra: a automação do EVO dispara um POST por pessoa e nunca passa por
  // lá — foi assim que as 47 chegaram.
  if ((await emCarencia([phone])).size) {
    return {
      ok: false,
      motivo: `em carência (recebeu campanha nos últimos ${config.campanha.carenciaDias} dias sem responder)`,
    };
  }

  const { data, error } = await supabase
    .from('crm_campanha_alvos')
    .upsert({
      campanha_id: campanha.id,
      phone,
      nome: (pessoa.firstName || pessoa.fullName || '').trim().split(/\s+/)[0] || null,
      evo_id_member: pessoa.idMember ?? null,
      evo_id_prospect: pessoa.idProspect ?? null,
      // O link é tokenizado por pessoa e NÃO se recupera depois: nenhuma
      // API do EVO devolve este token. Perder o evento é perder o link.
      link_checkout: payload?.links?.checkout ?? null,
      contexto: {
        segmento: descricao,
        origem: 'crm.segmentation.batch',
        status_evo: pessoa.status ?? null,
        email: pessoa.email ?? null,
        nome_completo: pessoa.fullName ?? null,
        recebido_em: new Date().toISOString(),
      },
      status: 'pendente',
    }, { onConflict: 'campanha_id,phone', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();

  if (error) return { ok: false, motivo: error.message };
  return { ok: true, alvoId: data?.id ?? null, campanha: campanha.slug };
}

// `telefoneValido` mudou-se para `evolution.js` em 28/08/2026: a régua de
// silêncio precisou da mesma checagem, e duas cópias divergiriam. O
// comportamento é idêntico — a função foi movida, não reescrita.

// ──────────────────────────────────────────────
// Porta de consentimento
// ──────────────────────────────────────────────

/**
 * Palavras que valem como "sim, pode contar" na resposta à abertura.
 * Só valem em mensagem curta: quem escreve um parágrafo está conversando,
 * e conversa é assunto do agente completo, não desta porta.
 */
const SIM = [
  /^sim\b/, /^s\b/, /^claro\b/, /^quero\b/, /^pode\b/, /^manda\b/, /^me conta\b/,
  /^tenho interesse\b/, /^gostaria\b/, /^por favor\b/, /^bora\b/, /^vamos\b/,
  /^aceito\b/, /^ok\b/, /^certo\b/, /^blz\b/, /^beleza\b/, /^positivo\b/,
];

/**
 * Palavras que valem como "não tenho interesse".
 *
 * Separado do opt-out de propósito: "não quero saber da oferta" é recusa da
 * campanha; "não quero receber mais mensagens" é pedido de saída, tratado
 * antes disto em `ehPedidoDeSaida` e com efeito permanente.
 */
const NAO = [
  // "não" sozinho é recusa; "não" seguido de qualquer coisa, não
  // necessariamente.
  //
  // A versão anterior era /^n[aã]o\b/, que casava com "Não entendi", "Não
  // sei", "Não tenho certeza" — pedidos de ajuda de quem ficou confuso.
  // Encerrar a campanha neles é perder exatamente quem estava interessado.
  // Mesma família de erro do "Para mim" em PEDIDOS_DE_SAIDA: âncora curta
  // demais numa língua em que a palavra continua.
  /^n[aã]o$/, /^n$/, /^nn$/,
  /^n[aã]o,? (obrigad|quero|tenho interesse|preciso|me interessa)/,
  /^n[aã]o tenho interesse\b/, /^sem interesse\b/,
  /^agora n[aã]o\b/, /^obrigad[oa]$/, /^dispenso\b/, /^negativo\b/,
];

/**
 * Lê a resposta à mensagem de abertura.
 *
 * Devolve 'sim', 'nao' ou 'outro'. **'outro' é o caminho seguro**: cai no
 * agente completo, que sabe lidar com qualquer coisa. Errar para 'outro'
 * custa tokens; errar para 'sim' manda oferta a quem não pediu, e errar
 * para 'nao' encerra quem estava interessado.
 *
 * Por isso não há adivinhação: frase longa é sempre 'outro', mesmo que
 * comece com "sim".
 *
 * @param {string} texto
 * @returns {'sim'|'nao'|'outro'}
 */
export function lerConsentimento(texto) {
  const limpo = normalizar(texto);
  if (!limpo) return 'outro';

  // Acima disto a pessoa não está respondendo sim ou não: está falando.
  if (limpo.length > 40) return 'outro';

  if (NAO.some(re => re.test(limpo))) return 'nao';
  if (SIM.some(re => re.test(limpo))) return 'sim';
  return 'outro';
}

/**
 * O alvo de campanha desta pessoa que está esperando resposta à abertura.
 * Devolve null quando a mensagem não tem nada a ver com campanha — que é o
 * caso da esmagadora maioria das conversas.
 */
export async function alvoAguardandoConsentimento(phone) {
  const { data } = await supabase
    .from('crm_campanha_alvos')
    .select('*, campanha:crm_campanhas(*)')
    .eq('phone', normalizePhone(phone))
    .eq('etapa_conversa', 'aguardando_consentimento')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** Move o alvo de etapa na conversa. */
export async function marcarEtapaConversa(alvoId, etapa) {
  await supabase
    .from('crm_campanha_alvos')
    .update({ etapa_conversa: etapa })
    .eq('id', alvoId);
}

/**
 * A campanha que trouxe esta pessoa, se houver.
 *
 * Devolve a oferta e o link de checkout DELA, para o agente completo saber
 * o que foi prometido. Sem isso ele lê a própria mensagem de campanha no
 * histórico — "montamos uma condição para quem já foi aluno" — e não faz
 * ideia de qual condição é, porque a oferta vive aqui e não no prompt.
 *
 * Aconteceu com a Paula Ferreira em 25/08/2026: a campanha prometia AQUA
 * anual 10x264, ela perguntou "como funciona", e o agente ofereceu Performa
 * 12x199. Coisas diferentes, na mesma conversa.
 *
 * Só vale enquanto a campanha está viva para ela. Quem recusou ou foi
 * suprimido não deve ter a oferta ressuscitada por uma pergunta solta meses
 * depois.
 *
 * @param {string} phone
 * @returns {Promise<{oferta:string, roteiro:string|null, link_checkout:string|null, slug:string}|null>}
 */
export async function campanhaDoContato(phone) {
  const { data } = await supabase
    .from('crm_campanha_alvos')
    .select('link_checkout, etapa_conversa, campanha:crm_campanhas(slug, oferta, roteiro)')
    .eq('phone', normalizePhone(phone))
    .in('status', ['agendado', 'enviado', 'respondeu'])
    .in('etapa_conversa', ['aguardando_consentimento', 'aceitou', 'conversando'])
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.campanha?.oferta) return null;

  return {
    slug: data.campanha.slug,
    oferta: data.campanha.oferta,
    roteiro: data.campanha.roteiro ?? null,
    link_checkout: data.link_checkout ?? null,
  };
}

// ──────────────────────────────────────────────
// Consultas
// ──────────────────────────────────────────────

export async function buscarCampanha(idOuSlug) {
  const coluna = typeof idOuSlug === 'number' || /^\d+$/.test(String(idOuSlug)) ? 'id' : 'slug';
  const { data } = await supabase
    .from('crm_campanhas')
    .select('*')
    .eq(coluna, idOuSlug)
    .maybeSingle();
  return data;
}

export async function campanhasAtivas() {
  const { data } = await supabase
    .from('crm_campanhas')
    .select('*')
    .eq('status', 'ativa')
    .order('id', { ascending: true });
  return data ?? [];
}

export async function resumo(idOuSlug = null) {
  let query = supabase.from('crm_campanhas_resumo').select('*');
  if (idOuSlug) {
    const coluna = /^\d+$/.test(String(idOuSlug)) ? 'id' : 'slug';
    query = query.eq(coluna, idOuSlug);
  }
  const { data } = await query;
  return data ?? [];
}

export const campanhas = {
  ehPedidoDeSaida, suprimir, estaSuprimido,
  absorverSegmentacao, lerConsentimento, alvoAguardandoConsentimento, marcarEtapaConversa,
  campanhaDoContato,
  reconciliarEnviados,
  montarAlvos, registrarResposta,
  distribuirHorarios, enviadosHoje, processarCampanha, conferirGuarda,
  buscarCampanha, campanhasAtivas, resumo, hojeSP,
};
