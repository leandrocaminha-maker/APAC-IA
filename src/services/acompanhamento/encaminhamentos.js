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
 *
 * ## A ponte (A5d)
 *
 * O briefing não leva mais o número do aluno: o professor fala com ele
 * citando o briefing, pelo número da academia (`ponte.js`). Por isso o
 * encaminhamento guarda `aluno_phone` (018) — o número que ativou o
 * acompanhamento, ou o do cadastro.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { sendText, telefoneValido } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { inicioDoDiaSP } from '../limite-envio.js';
import { buscarEquipe } from './prescrev.js';
import { emHorario, prazoDaResposta, proximoInicio, quandoEnviar } from './horario.js';
import {
  SEM_ENCAMINHAMENTO, acompanhamentoDaFicha, combinadoDaFicha, coordenadorDePlantao, destinoDoAluno, mesmoNumero, rotear,
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

/**
 * O WhatsApp do aluno para a ponte: o número que ativou o acompanhamento
 * (é o da conversa, como o WhatsApp o escreve), senão o celular do cadastro.
 * Inscrição pendente não conta — o número ainda não foi confirmado.
 */
function telefoneDoAluno(inscricao, ficha) {
  if (inscricao && ['ativa', 'pausada'].includes(inscricao.status)) return inscricao.phone;
  return telefoneValido(ficha?.aluno?.celular_cadastro);
}

const linkDaFicha = (clienteId) => `${config.acompanhamento.prescrev.url.replace(/\/$/, '')}/dashboard/clientes/${clienteId}`;

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
 * Abre os encaminhamentos dos avisos à equipe de um aluno — em ensaio
 * ('simulado') até `ACOMPANHAMENTO_ENCAMINHAMENTOS_REAIS`.
 * Um por `chave`: o mesmo aviso em dias seguidos não abre outro.
 * @returns {Promise<number>} quantos novos
 */
export async function registrarDaRegua({ ficha, avisos, treinos, hoje, equipe, ativos, inscricao = null }) {
  const horarios = await horariosDaEquipe(equipe);
  const alunoPhone = telefoneDoAluno(inscricao, ficha);
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
      ponte: !!alunoPhone,
      linkFicha: linkDaFicha(ficha.cliente_id),
    });
    // Fase de teste: 'simulado'. Com ACOMPANHAMENTO_ENCAMINHAMENTOS_REAIS, o
    // briefing sai — no horário de quem recebe.
    const real = config.acompanhamento.encaminhamentosReais;
    const enc = {
      id: randomUUID(), chave, origem: 'regua', cliente_id: ficha.cliente_id, aluno: ficha.aluno?.primeiro_nome ?? 'Aluno',
      aluno_phone: alunoPhone, motivo_codigo: aviso.codigo, motivo: aviso.motivo, urgencia: aviso.urgencia, resumo: aviso.texto,
      professor_profile_id: professor?.profile_id ?? null, professor_nome: professor?.nome ?? null,
      destino_origem: professor?.origem ?? null,
      nivel: rota.nivel,
      destinatario_profile_id: rota.pessoa?.profile_id ?? null, destinatario_nome: rota.pessoa?.nome ?? null,
      destinatario_phone: rota.pessoa?.phone ?? null,
      status: !real ? 'simulado' : rota.pessoa ? 'na_fila' : 'sem_destino',
      texto_briefing: texto, enviar_em: !real ? rota.quando?.enviarEm?.toISOString() ?? null : null,
    };
    const historico = [evento(real ? 'aberto pela régua' : 'aberto em ensaio',
      [real ? null : previsao(rota), ...rota.notas].filter(Boolean).join(' · '))];
    const { error } = await supabase.from('acomp_encaminhamentos').insert({ ...enc, historico });
    if (error) {
      if (error.code !== '23505') logger.warn('[encaminhamento] Não deu para abrir:', error.message);
      continue;
    }
    if (real && rota.pessoa) {
      await entregar(enc, rota.pessoa, horarios.get(rota.pessoa.profile_id) ?? null, { nivel: rota.nivel, texto, historico })
        .catch(err => logger.warn(`[encaminhamento] ${enc.id} aberto e não entregue: ${err.message}`));
    }
    novos++;
  }
  return novos;
}

const MOTIVO_DA_CATEGORIA = {
  dor_ou_lesao: 'dor ou lesão', saude: 'saúde', ajuste_de_treino: 'ajuste de treino',
  ausencia_ou_desanimo: 'ausência ou desânimo', pedido_do_aluno: 'o aluno quer falar com você', outro: 'conversa com o aluno',
};

/**
 * O encaminhamento que a Leia abre na conversa com o aluno (§6.4). Com
 * `encaminhamentosReais` desligado (fase de teste), abre 'simulado' com a
 * previsão de quem receberia e quando; ligado, roteia e entrega como os da
 * régua — no horário de quem recebe.
 * @returns {Promise<object>} { status, destinatario, enviarEm }
 */
export async function registrarDaLeia({ ficha, categoria, urgencia, resumo, phoneAluno, treinos = [], hoje }) {
  const [equipe, ativos] = await Promise.all([buscarEquipe(), equipeAtivada()]);
  const horarios = await horariosDaEquipe(equipe);
  const professor = destinoDoAluno({ ficha, treinos, hoje, equipe });
  const rota = rotear({ urgencia, origem: 'leia', professorId: professor?.profile_id ?? null, ativos, horarios, agora: agora() });
  const motivo = MOTIVO_DA_CATEGORIA[categoria] ?? 'conversa com o aluno';
  // O número de quem está conversando com a Leia: é o da conversa.
  const alunoPhone = phoneAluno ?? telefoneValido(ficha.aluno?.celular_cadastro);
  const texto = textoDoBriefing({
    aluno: ficha.aluno?.primeiro_nome ?? 'Aluno', idade: ficha.aluno?.idade ?? null, motivo, urgencia, resumo,
    combinado: combinadoDaFicha(ficha), acompanhamento: acompanhamentoDaFicha(ficha),
    ponte: !!alunoPhone,
    linkFicha: linkDaFicha(ficha.cliente_id),
  });
  const real = config.acompanhamento.encaminhamentosReais;
  const enc = {
    id: randomUUID(), chave: `leia:${ficha.cliente_id}:${randomUUID()}`, origem: 'leia', cliente_id: ficha.cliente_id,
    aluno: ficha.aluno?.primeiro_nome ?? 'Aluno', aluno_phone: alunoPhone, motivo_codigo: categoria, motivo, urgencia, resumo,
    professor_profile_id: professor?.profile_id ?? null, professor_nome: professor?.nome ?? null,
    destino_origem: professor?.origem ?? null, nivel: rota.nivel,
    destinatario_profile_id: rota.pessoa?.profile_id ?? null, destinatario_nome: rota.pessoa?.nome ?? null,
    destinatario_phone: rota.pessoa?.phone ?? null,
    status: !real ? 'simulado' : rota.pessoa ? 'na_fila' : 'sem_destino',
    texto_briefing: texto, enviar_em: !real ? rota.quando?.enviarEm?.toISOString() ?? null : null,
  };
  const historico = [evento(real ? 'aberto pela Leia' : 'aberto pela Leia, em ensaio', [real ? null : previsao(rota), ...rota.notas].filter(Boolean).join(' · '))];
  const { error } = await supabase.from('acomp_encaminhamentos').insert({ ...enc, historico });
  if (error) throw new Error(`acomp_encaminhamentos: ${error.message}`);

  let status = enc.status;
  if (real && rota.pessoa) {
    status = await entregar(enc, rota.pessoa, horarios.get(rota.pessoa.profile_id) ?? null, { nivel: rota.nivel, texto, historico });
  }
  return { status, destinatario: rota.pessoa?.nome ?? null, nivel: rota.nivel, enviarEm: rota.quando?.enviarEm ?? null };
}

/**
 * O envio de teste do painel: um briefing com aluno fictício para quem
 * ativou o EQUIPE. Valida o caminho inteiro — chegar, responder, repassar —
 * e a regra do horário: fora dele, fica na fila até o turno começar.
 *
 * Com `alunoPhone`, um número de verdade faz o papel do aluno, e a ponte
 * (A5d) se testa sem aluno de verdade: o professor cita o briefing, a
 * mensagem chega a esse número, e a resposta volta ao professor. Não pode ser
 * de quem é da equipe — a porta da equipe pegaria as respostas antes da ponte.
 * @returns {Promise<object>} o encaminhamento, com `status` e `enviar_em`
 */
export async function criarTeste({ profileId, alunoPhone = null }) {
  const [ativos, horarios] = await Promise.all([equipeAtivada(), horariosDaEquipe()]);
  const membro = ativos.find(a => a.profile_id === profileId);
  if (!membro) throw new Error('Esta pessoa ainda não ativou o EQUIPE no WhatsApp.');
  const horario = horarios.get(profileId) ?? null;
  if (!proximoInicio(horario)) {
    throw new Error(`${membro.nome} não tem horário de trabalho no Prescrev — fora do horário nada é enviado.`);
  }
  let aluno = null;
  if (alunoPhone) {
    aluno = telefoneValido(alunoPhone);
    if (!aluno) throw new Error('O WhatsApp do aluno de teste precisa ser um celular com DDD (11 dígitos).');
    if (ativos.some(a => mesmoNumero(a.phone, aluno))) {
      throw new Error('Este número é de alguém que ativou o EQUIPE: as respostas iriam para a porta da equipe, e não para a ponte. Use outro.');
    }
  }

  const enc = {
    id: randomUUID(),
    chave: `teste:${randomUUID()}`,
    origem: 'teste',
    aluno: 'Aluno de teste',
    aluno_phone: aluno,
    motivo_codigo: 'teste',
    motivo: 'teste do caminho do encaminhamento',
    urgencia: 'hoje',
    resumo: aluno
      ? 'Encaminhamento de teste, sem aluno de verdade: responda citando esta mensagem para falar com o número de teste, ou 1, 2 ou 3.'
      : 'Encaminhamento de teste, sem aluno de verdade: responda 1, 2 ou 3 para conferir o caminho.',
    professor_profile_id: membro.profile_id, professor_nome: membro.nome, destino_origem: 'teste',
    nivel: 'professor',
    destinatario_profile_id: membro.profile_id, destinatario_nome: membro.nome, destinatario_phone: membro.phone,
    status: 'na_fila',
  };
  enc.texto_briefing = textoDoBriefing({
    teste: true, aluno: enc.aluno, motivo: enc.motivo, urgencia: enc.urgencia, resumo: enc.resumo, ponte: !!aluno,
  });
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

/** O encaminhamento a que um 1/2/3 sem citação responde: o mais recente que espera por quem mandou. */
async function encaminhamentoDaResposta(phone, numero) {
  const { data: aguardando } = await supabase.from('acomp_encaminhamentos').select('*')
    .eq('status', 'aguardando').eq('destinatario_phone', phone)
    .order('enviado_em', { ascending: false }).limit(1).maybeSingle();
  if (aguardando || numero !== '2') return aguardando;
  // "2" depois de assumir — inclusive pela ponte, que assume na primeira mensagem.
  const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data: assumido } = await supabase.from('acomp_encaminhamentos').select('*')
    .eq('status', 'assumido').eq('destinatario_phone', phone).gte('respondido_em', desde)
    .order('respondido_em', { ascending: false }).limit(1).maybeSingle();
  return assumido;
}

/** Os estados em que um 1/2/3 ainda muda alguma coisa. */
const RESPONDIVEIS = ['aguardando', 'assumido', 'na_fila', 'sem_destino'];

/** Fecha a ponte do encaminhamento resolvido: o aluno volta à Leia. */
async function fecharPontesDo(encId, motivo) {
  const { error } = await supabase.from('acomp_pontes')
    .update({ fechada_em: new Date().toISOString(), motivo_fechamento: motivo })
    .eq('encaminhamento_id', encId).is('fechada_em', null);
  if (error && error.code !== 'PGRST205') logger.warn(`[encaminhamento] Ponte de ${encId} não fechada: ${error.message}`);
}

/**
 * A resposta 1/2/3 de quem é da equipe. Citando um briefing (`encaminhamentoId`,
 * a ponte), vale para aquele encaminhamento; sem citação, para o mais recente
 * que espera por quem respondeu. É resposta a mensagem dele: sai a qualquer hora.
 * @returns {Promise<string>} o texto de volta
 */
export async function responderBriefing({ phone, numero, nota, encaminhamentoId = null }) {
  let enc;
  if (encaminhamentoId) {
    const { data } = await supabase.from('acomp_encaminhamentos').select('*').eq('id', encaminhamentoId).maybeSingle();
    enc = data && RESPONDIVEIS.includes(data.status) ? data : null;
  } else {
    enc = await encaminhamentoDaResposta(phone, numero);
  }
  if (!enc) return SEM_ENCAMINHAMENTO;

  const quem = enc.destinatario_nome ?? 'a equipe';
  const resposta = {
    respondido_em: new Date().toISOString(), resposta: numero, nota,
    historico: [...(enc.historico ?? []), evento(`resposta ${numero}`, [quem, nota].filter(Boolean).join(': '))],
  };

  if (numero === '1' || numero === '2') {
    await atualizar(enc.id, { ...resposta, status: numero === '1' ? 'assumido' : 'resolvido' });
    if (numero === '2') await fecharPontesDo(enc.id, 'resolvido');
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

/**
 * A primeira mensagem do professor pela ponte vale como "1 — assumo"
 * (decisão de 09/10/2026). Quem escreve passa a ser o destinatário: o "2" sem
 * citação dele encontra o encaminhamento, e o prazo de resposta para de correr.
 */
export async function assumirPelaPonte(enc, membro) {
  if (!['na_fila', 'aguardando', 'sem_destino'].includes(enc.status)) return;
  await atualizar(enc.id, {
    status: 'assumido', respondido_em: new Date().toISOString(), resposta: '1',
    destinatario_profile_id: membro.profile_id, destinatario_nome: membro.nome, destinatario_phone: membro.phone,
    historico: [...(enc.historico ?? []), evento('assumido pela ponte', `${membro.nome} escreveu ao aluno`)],
  });
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
  const lista = data ?? [];

  // A ponte de cada um (A5d): 'aberta', 'fechada' ou null — a tela mostra a conversa.
  const ids = lista.map(e => e.id);
  const ponte = new Map();
  if (ids.length) {
    const { data: pontes, error: errPonte } = await supabase.from('acomp_pontes')
      .select('encaminhamento_id, fechada_em').in('encaminhamento_id', ids);
    if (errPonte && errPonte.code !== 'PGRST205') logger.warn('[encaminhamento] acomp_pontes:', errPonte.message);
    for (const p of pontes ?? []) {
      if (ponte.get(p.encaminhamento_id) !== 'aberta') ponte.set(p.encaminhamento_id, p.fechada_em ? 'fechada' : 'aberta');
    }
  }
  return lista.map(e => ({ ...e, ponte: ponte.get(e.id) ?? null }));
}
