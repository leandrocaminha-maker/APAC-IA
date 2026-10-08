/**
 * src/services/acompanhamento/encaminhamentos.js
 * Os encaminhamentos do acompanhamento ao professor: abrir, avisar,
 * responder, repassar ao coordenador.
 *
 * ## O caminho (§7.3 do PLANO_ACOMPANHAMENTO.md do Prescrev)
 *
 * 1. Algo pede o professor: um aviso à equipe da régua (treino vencendo ou
 *    vencido, ciclo em risco e ausência na adesão), o envio de teste do
 *    painel, e — na etapa A3 — a Leia.
 * 2. Abre-se o encaminhamento, com o professor do aluno (`destinoDoAluno`),
 *    quem recebe e quando (`rotear`) e o texto do briefing (modelo fixo,
 *    `textoDoBriefing`).
 * 3. O briefing sai do número da academia para o WhatsApp de quem ativou o
 *    EQUIPE, gravado em `wa_messages` como `bot:briefing` — sem isso, o eco
 *    do envio seria lido como consultor digitando. Teto próprio de 20 por dia
 *    (D5), fora do teto do número.
 * 4. O professor responde 1 (assumo), 2 (resolvi) ou 3 (não é comigo); o
 *    texto depois do número vira nota. Sem "1" no prazo, ou com "3", vai ao
 *    coordenador de plantão. A coordenação também sem resposta: fica na tela
 *    Acompanhamento do Prescrev (`sem_destino`).
 *
 * ## Só no horário de trabalho
 *
 * Decisão do responsável em 08/10/2026: nada sai para a equipe fora do
 * horário de quem recebe (cadastrado no Prescrev; regra em `horario.js`).
 * Fora dele o encaminhamento fica `na_fila` até o começo do turno; urgência
 * "hoje" sem turno no resto do dia vai à coordenação que trabalha hoje; sem
 * horário a pessoa não recebe. O prazo de "hoje" conta 2 horas DE TRABALHO.
 * Sem a lista da equipe do Prescrev não há como saber o horário: nada sai
 * (falha fechada), e o worker tenta de novo no ciclo seguinte. `enviar`
 * confere o horário mais uma vez, na hora de mandar.
 *
 * ## Na fase de teste
 *
 * Decisão do responsável em 08/10/2026: os encaminhamentos da régua ficam
 * `simulado` — abertos, com o texto pronto e o horário em que sairiam, e NÃO
 * enviados. Só o envio de teste do painel sai, com aluno fictício: valida o
 * caminho inteiro sem mandar dado de aluno nenhum.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { sendText } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { inicioDoDiaSP } from '../limite-envio.js';
import { buscarEquipe } from './prescrev.js';
import { emHorario, prazoDaResposta, proximoInicio, quandoEnviar } from './horario.js';
import {
  SEM_ENCAMINHAMENTO, acompanhamentoDaFicha, combinadoDaFicha, coordenadorDePlantao, destinoDoAluno, rotear,
  textoDaResposta, textoDoBriefing,
} from './comandos.js';

const agora = () => new Date();
const evento = (evento, detalhe = null) => ({ em: new Date().toISOString(), evento, detalhe });
const quando = (d) => d.toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** Quem da equipe ativou o EQUIPE (014). Antes da migration, ninguém. */
export async function equipeAtivada() {
  const { data, error } = await supabase.from('acomp_equipe').select('*');
  if (error) {
    if (error.code !== 'PGRST205') logger.warn('[encaminhamento] acomp_equipe:', error.message);
    return [];
  }
  return data ?? [];
}

/** O horário de cada um, da lista do Prescrev. Sem a lista, lança: ninguém recebe às cegas. */
async function horariosDaEquipe(equipe = null) {
  const lista = equipe ?? await buscarEquipe();
  return new Map(lista.map(m => [m.profile_id, m.horario ?? null]));
}

async function atualizar(id, campos) {
  const { error } = await supabase.from('acomp_encaminhamentos').update(campos).eq('id', id);
  if (error) throw new Error(`acomp_encaminhamentos: ${error.message}`);
}

async function briefingsHoje() {
  const { count, error } = await supabase.from('wa_messages').select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound').eq('sent_by', 'bot:briefing').gte('created_at', inicioDoDiaSP().toISOString());
  if (error) throw new Error(`a contagem de briefings do dia falhou: ${error.message}`);
  return count ?? 0;
}

/** Manda um briefing e grava a mensagem. Falha fechada no horário e no teto. */
async function enviar(enc, pessoa, texto, horario) {
  // A última trava: nada sai para a equipe fora do horário de quem recebe.
  if (!emHorario(horario)) throw new Error(`${pessoa.nome} está fora do horário de trabalho`);
  const teto = config.acompanhamento.briefingTetoDiario;
  if (teto > 0 && (await briefingsHoje()) >= teto) throw new Error(`teto de ${teto} briefings por dia atingido`);
  const contato = await getOrCreateContact(pessoa.phone, pessoa.nome);
  const conversa = await getOrCreateConversation(contato.id);
  const r = await sendText(pessoa.phone, texto);
  await saveMessage({
    conversationId: conversa.id,
    contactId: contato.id,
    direction: 'outbound',
    content: texto,
    contentType: 'text',
    sentBy: 'bot:briefing',
    evolutionMsgId: r?.key?.id || null,
    status: 'sent',
    metadata: { encaminhamento: enc.id },
  });
}

/**
 * Leva o encaminhamento a `pessoa`: agora, se ela está no horário; senão,
 * na fila até o começo do turno. Grava o novo estado e o devolve.
 * @returns {Promise<'aguardando'|'na_fila'>}
 */
async function entregar(enc, pessoa, horario, { nivel, texto, historico }) {
  const q = quandoEnviar({ horario, urgencia: enc.urgencia, agora: agora(), exigirHoje: false });
  if (q.acao === 'indisponivel') throw new Error(`${pessoa.nome}: ${q.motivo}`);
  const destino = {
    nivel, texto_briefing: texto,
    destinatario_profile_id: pessoa.profile_id, destinatario_nome: pessoa.nome, destinatario_phone: pessoa.phone,
  };
  if (q.acao === 'fila') {
    await atualizar(enc.id, {
      ...destino, status: 'na_fila', enviar_em: q.enviarEm.toISOString(),
      historico: [...historico, evento('na fila', `${pessoa.nome} fora do horário de trabalho: sai ${quando(q.enviarEm)}`)],
    });
    return 'na_fila';
  }
  await enviar(enc, pessoa, texto, horario);
  const enviadoEm = agora();
  await atualizar(enc.id, {
    ...destino, status: 'aguardando', enviar_em: null, enviado_em: enviadoEm.toISOString(),
    prazo_resposta: prazoDaResposta(horario, enc.urgencia, enviadoEm)?.toISOString() ?? null,
    historico: [...historico, evento(nivel === 'coordenacao' ? 'enviado à coordenação' : 'enviado', pessoa.nome)],
  });
  return 'aguardando';
}

/** O que o ensaio diz que aconteceria, numa linha do histórico. */
function previsao(rota) {
  if (!rota.pessoa) return 'no envio real, ficaria sem destino — na tela do Prescrev';
  const para = `${rota.pessoa.nome}${rota.nivel === 'coordenacao' ? ' (coordenação)' : ''}`;
  return rota.quando.acao === 'enviar'
    ? `no envio real, sairia na hora para ${para}`
    : `no envio real, esperaria o turno e sairia ${quando(rota.quando.enviarEm)} para ${para}`;
}

/**
 * Abre, em ensaio, os encaminhamentos dos avisos à equipe de um aluno.
 * Um por `chave`: o mesmo aviso em dias seguidos não abre outro.
 * @returns {Promise<number>} quantos novos
 */
export async function registrarDaRegua({ ficha, avisos, treinos, hoje, equipe, ativos }) {
  const horarios = await horariosDaEquipe(equipe);
  let novos = 0;
  for (const aviso of avisos ?? []) {
    const chave = `regua:${ficha.cliente_id}:${aviso.codigo}:${aviso.referencia}`;
    const { data: ja } = await supabase.from('acomp_encaminhamentos').select('id').eq('chave', chave).maybeSingle();
    if (ja) continue;

    const professor = destinoDoAluno({ ficha, treinos, hoje, equipe });
    const rota = rotear({
      urgencia: aviso.urgencia, origem: 'regua', professorId: professor?.profile_id ?? null, ativos, horarios, agora: agora(),
    });
    const texto = textoDoBriefing({
      aluno: ficha.aluno?.primeiro_nome ?? 'Aluno',
      idade: ficha.aluno?.idade ?? null,
      motivo: aviso.motivo,
      urgencia: aviso.urgencia,
      resumo: aviso.texto,
      combinado: combinadoDaFicha(ficha),
      acompanhamento: acompanhamentoDaFicha(ficha),
      whatsappAluno: ficha.aluno?.celular_cadastro ?? null,
      linkFicha: `${config.acompanhamento.prescrev.url.replace(/\/$/, '')}/dashboard/clientes/${ficha.cliente_id}`,
    });
    const { error } = await supabase.from('acomp_encaminhamentos').insert({
      chave, origem: 'regua', cliente_id: ficha.cliente_id, aluno: ficha.aluno?.primeiro_nome ?? 'Aluno',
      motivo_codigo: aviso.codigo, motivo: aviso.motivo, urgencia: aviso.urgencia, resumo: aviso.texto,
      professor_profile_id: professor?.profile_id ?? null, professor_nome: professor?.nome ?? null,
      destino_origem: professor?.origem ?? null,
      nivel: rota.nivel,
      destinatario_profile_id: rota.pessoa?.profile_id ?? null, destinatario_nome: rota.pessoa?.nome ?? null,
      destinatario_phone: rota.pessoa?.phone ?? null,
      status: 'simulado', texto_briefing: texto, enviar_em: rota.quando?.enviarEm?.toISOString() ?? null,
      historico: [evento('aberto em ensaio', [previsao(rota), ...rota.notas].join(' · '))],
    });
    if (error) {
      if (error.code !== '23505') logger.warn('[encaminhamento] Não deu para abrir:', error.message);
      continue;
    }
    novos++;
  }
  return novos;
}

/**
 * O envio de teste do painel: um briefing com aluno fictício para quem
 * ativou o EQUIPE. Valida o caminho inteiro — chegar, responder, repassar —
 * e a regra do horário: fora dele, fica na fila até o turno começar.
 * @returns {Promise<object>} o encaminhamento, com `status` e `enviar_em`
 */
export async function criarTeste({ profileId }) {
  const [ativos, horarios] = await Promise.all([equipeAtivada(), horariosDaEquipe()]);
  const membro = ativos.find(a => a.profile_id === profileId);
  if (!membro) throw new Error('Esta pessoa ainda não ativou o EQUIPE no WhatsApp.');
  const horario = horarios.get(profileId) ?? null;
  if (!proximoInicio(horario)) {
    throw new Error(`${membro.nome} não tem horário de trabalho no Prescrev — fora do horário nada é enviado.`);
  }

  const enc = {
    id: randomUUID(),
    chave: `teste:${randomUUID()}`,
    origem: 'teste',
    aluno: 'Aluno de teste',
    motivo_codigo: 'teste',
    motivo: 'teste do caminho do encaminhamento',
    urgencia: 'hoje',
    resumo: 'Encaminhamento de teste, sem aluno de verdade: responda 1, 2 ou 3 para conferir o caminho.',
    professor_profile_id: membro.profile_id, professor_nome: membro.nome, destino_origem: 'teste',
    nivel: 'professor',
    destinatario_profile_id: membro.profile_id, destinatario_nome: membro.nome, destinatario_phone: membro.phone,
    status: 'na_fila',
  };
  enc.texto_briefing = textoDoBriefing({ teste: true, aluno: enc.aluno, motivo: enc.motivo, urgencia: enc.urgencia, resumo: enc.resumo });
  const historico = [evento('teste aberto', membro.nome)];

  const { error } = await supabase.from('acomp_encaminhamentos').insert({ ...enc, historico });
  if (error) throw new Error(`acomp_encaminhamentos: ${error.message}`);
  let status;
  try {
    status = await entregar(enc, membro, horario, { nivel: 'professor', texto: enc.texto_briefing, historico });
  } catch (err) {
    await atualizar(enc.id, { status: 'cancelado', historico: [...historico, evento('envio falhou', err.message)] });
    throw err;
  }
  const { data } = await supabase.from('acomp_encaminhamentos').select('status, enviar_em').eq('id', enc.id).maybeSingle();
  logger.info(`[encaminhamento] Teste para ${membro.nome}: ${status}`);
  return { ...enc, status, enviar_em: data?.enviar_em ?? null };
}

/**
 * Leva o encaminhamento ao coordenador de plantão — o que trabalha a
 * tempo. Sem nenhum, ou quando é ele mesmo quem não assumiu, fica sem
 * destino — na tela.
 * @returns {Promise<string|null>} o nome de quem recebe
 */
async function repassar(enc, porque) {
  const [ativos, horarios] = await Promise.all([equipeAtivada(), horariosDaEquipe()]);
  const coord = coordenadorDePlantao(ativos, enc.destinatario_phone, {
    horarios, agora: agora(), urgencia: enc.urgencia, exigirHoje: enc.urgencia === 'hoje' && enc.origem !== 'teste',
  });
  const historico = [...(enc.historico ?? []), evento('repasse', porque)];
  if (!coord) {
    await atualizar(enc.id, {
      status: 'sem_destino', enviar_em: null,
      historico: [...historico, evento('sem coordenação com EQUIPE ativado e horário que sirva')],
    });
    return null;
  }
  const texto = `*Repassado:* ${porque}\n${enc.texto_briefing}`;
  await entregar(enc, coord, horarios.get(coord.profile_id) ?? null, { nivel: 'coordenacao', texto, historico });
  return coord.nome;
}

/**
 * A resposta 1/2/3 de quem é da equipe ao encaminhamento mais recente que
 * espera por ele. É resposta a mensagem dele: sai a qualquer hora.
 * @returns {Promise<string>} o texto de volta
 */
export async function responderBriefing({ phone, numero, nota }) {
  const { data: enc } = await supabase.from('acomp_encaminhamentos').select('*')
    .eq('status', 'aguardando').eq('destinatario_phone', phone)
    .order('enviado_em', { ascending: false }).limit(1).maybeSingle();
  if (!enc) return SEM_ENCAMINHAMENTO;

  const quem = enc.destinatario_nome ?? 'a equipe';
  const resposta = {
    respondido_em: new Date().toISOString(), resposta: numero, nota,
    historico: [...(enc.historico ?? []), evento(`resposta ${numero}`, [quem, nota].filter(Boolean).join(': '))],
  };

  if (numero === '1' || numero === '2') {
    await atualizar(enc.id, { ...resposta, status: numero === '1' ? 'assumido' : 'resolvido' });
    return textoDaResposta({ numero, aluno: enc.aluno });
  }

  // 3: não é comigo.
  if (enc.nivel === 'coordenacao') {
    await atualizar(enc.id, { ...resposta, status: 'sem_destino' });
    return textoDaResposta({ numero, aluno: enc.aluno, nivel: 'coordenacao' });
  }
  await atualizar(enc.id, resposta);
  let repassadoA = null;
  try {
    repassadoA = await repassar({ ...enc, historico: resposta.historico }, `${quem} respondeu 3 (não é comigo)`);
  } catch (err) {
    // Sem a lista da equipe, o prazo vencido leva adiante no próximo ciclo.
    logger.warn(`[encaminhamento] Repasse de ${enc.id} adiado: ${err.message}`);
  }
  return textoDaResposta({ numero, aluno: enc.aluno, repassadoA });
}

/** Solta o que estava na fila e chegou ao turno de quem recebe. */
async function soltarFila(enc, ativos, horarios) {
  const pessoa = ativos.find(a => a.profile_id === enc.destinatario_profile_id);
  const horario = pessoa ? horarios.get(pessoa.profile_id) ?? null : null;
  if (!pessoa || !proximoInicio(horario)) {
    const porque = `${enc.destinatario_nome ?? 'quem ia receber'} ${pessoa ? 'ficou sem horário de trabalho' : 'não está mais com o EQUIPE ativado'}`;
    if (enc.nivel === 'professor' && enc.origem !== 'teste') return repassar(enc, porque);
    return atualizar(enc.id, { status: 'sem_destino', enviar_em: null, historico: [...(enc.historico ?? []), evento('sem destino', porque)] });
  }
  return entregar(enc, pessoa, horario, { nivel: enc.nivel, texto: enc.texto_briefing, historico: enc.historico ?? [] });
}

/**
 * A cada poucos minutos (worker): a fila que chegou ao turno sai, e o que
 * passou do prazo sem "1" anda — professor → coordenação; coordenação → tela.
 * @returns {Promise<number>} quantos foram tratados
 */
export async function processarEncaminhamentos() {
  const agoraIso = new Date().toISOString();
  const [fila, vencidos] = await Promise.all([
    supabase.from('acomp_encaminhamentos').select('*').eq('status', 'na_fila').lte('enviar_em', agoraIso),
    supabase.from('acomp_encaminhamentos').select('*').eq('status', 'aguardando').lt('prazo_resposta', agoraIso),
  ]);
  for (const r of [fila, vencidos]) {
    if (r.error) {
      if (r.error.code !== 'PGRST205') logger.warn('[encaminhamento] Fila e prazos não conferidos:', r.error.message);
      return 0;
    }
  }
  if (!fila.data.length && !vencidos.data.length) return 0;

  const [ativos, horarios] = await Promise.all([equipeAtivada(), horariosDaEquipe()]);
  for (const enc of fila.data) {
    try {
      await soltarFila(enc, ativos, horarios);
    } catch (err) {
      logger.warn(`[encaminhamento] Fila de ${enc.id} não tratada: ${err.message}`);
    }
  }
  for (const enc of vencidos.data) {
    try {
      if (enc.nivel === 'professor') {
        await repassar(enc, `${enc.destinatario_nome ?? 'o professor'} não respondeu no prazo`);
      } else {
        await atualizar(enc.id, {
          status: 'sem_destino', historico: [...(enc.historico ?? []), evento('coordenação sem resposta no prazo')],
        });
      }
    } catch (err) {
      logger.warn(`[encaminhamento] Prazo de ${enc.id} não tratado: ${err.message}`);
    }
  }
  return fila.data.length + vencidos.data.length;
}

/** Quem ativou o EQUIPE, sem o número, e se está no horário agora — para os painéis. */
export async function ativadosComHorario() {
  const ativos = await equipeAtivada();
  let horarios = null;
  try { horarios = await horariosDaEquipe(); } catch (err) {
    logger.warn('[encaminhamento] Sem a lista da equipe para mostrar o horário:', err.message);
  }
  return ativos.map(a => {
    const horario = horarios?.get(a.profile_id) ?? null;
    const proximo = horarios ? proximoInicio(horario) : null;
    return {
      profile_id: a.profile_id, nome: a.nome, papel: a.papel, ativado_em: a.ativado_em,
      horario: !horarios ? 'desconhecido' : !proximo ? 'sem_horario' : emHorario(horario) ? 'no_horario' : 'fora',
      proximo_turno: proximo && !emHorario(horario) ? proximo.toISOString() : null,
    };
  });
}

/** Os encaminhamentos dos últimos dias, do mais novo ao mais velho. */
export async function listarEncaminhamentos({ dias = 30 } = {}) {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  const { data, error } = await supabase.from('acomp_encaminhamentos')
    .select('id, origem, cliente_id, aluno, motivo_codigo, motivo, urgencia, resumo, professor_profile_id, professor_nome, '
      + 'destino_origem, nivel, destinatario_profile_id, destinatario_nome, status, texto_briefing, enviar_em, enviado_em, '
      + 'prazo_resposta, respondido_em, resposta, nota, historico, created_at')
    .gte('created_at', desde).order('created_at', { ascending: false });
  if (error) throw new Error(`acomp_encaminhamentos: ${error.message}`);
  return data ?? [];
}
