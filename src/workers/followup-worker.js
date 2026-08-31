/**
 * src/workers/followup-worker.js
 * Envia os follow-ups de venda que venceram.
 *
 * O agente só roda quando chega mensagem — é um `messages.create` por
 * mensagem recebida. Consequência: **quem some, some em silêncio**, e
 * nenhuma regra de prompt recupera essa conversa, porque não existe turno
 * em que o modelo possa agir. Este worker é o turno que faltava.
 *
 * Cada envio segue três passos que não podem trocar de ordem:
 *
 *   1. **Reconferir o mundo.** O lead pode ter convertido, sido perdido ou
 *      respondido desde que o follow-up foi agendado. Mandar assim mesmo é
 *      o erro mais visível que um follow-up automático comete.
 *   2. **Consultar o EVO** quando o assunto depende de um fato de lá —
 *      hoje, se a pessoa compareceu à aula.
 *   3. **Gerar o texto na hora**, com esse contexto, em vez de disparar
 *      uma frase guardada.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { followup } from '../services/followup.js';
import { controle } from '../services/controle.js';
import { evoClient } from '../services/evo-client.js';
import { aiAgent } from '../services/ai-agent.js';
import { funil } from '../services/funil.js';
import { saveMessage } from '../services/contacts.js';
import { sendText, telefoneValido } from '../services/evolution.js';

let rodando = false;

/** Etapas em que um follow-up de venda deixou de fazer sentido. */
const ETAPAS_MORTAS = new Set(['ganho', 'perdido', 'finalizado']);

/**
 * Trilhas que recebem follow-up de venda. Só uma.
 *
 * A varredura já não escolhe ninguém de fora dela, mas o worker confere de
 * novo na hora de enviar: entre o agendamento e o envio passam horas, e é
 * nesse intervalo que a Leia descobre que o "lead" é o fornecedor de
 * toalha. Segurar aqui é o que impede a linha já agendada de sair mesmo
 * assim.
 */
const TRILHA_DE_VENDA = 'lead';

// ──────────────────────────────────────────────
// A instrução que vai para a Leia
// ──────────────────────────────────────────────

/**
 * Monta a instrução interna que orienta a mensagem.
 *
 * Vai como turno de usuário marcado — e **não é gravada no histórico**.
 * Só a resposta gerada é salva. Assim a instrução orienta este turno sem
 * virar uma fala falsa do cliente nas conversas seguintes.
 */
function instrucao(tipo, { lead, presenca, contexto }) {
  const atividade = contexto?.atividade || lead.experimental_activity || 'a aula';
  const quando = contexto?.aula
    ? new Date(contexto.aula).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit',
        month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : null;

  // Contexto da régua do silêncio, gravado pela varredura no agendamento.
  //
  // `dias_parado` vira texto aproximado de propósito: o roteiro proíbe
  // comentar o silêncio, então o número serve para a Leia calibrar o tom
  // (retomar de leve ou reconhecer a distância), não para ela citar.
  const dias = contexto?.dias_parado;
  const parado = dias >= 7 ? 'mais de uma semana'
    : dias >= 2 ? `${dias} dias`
    : null;

  const autoria = String(contexto?.ultima_fala_de || '').startsWith('human:')
    ? 'de um consultor da academia (o histórico acima mostra qual foi)'
    : 'sua';

  const cabeca =
    '[INSTRUÇÃO INTERNA DO SISTEMA — isto NÃO é mensagem do cliente. ' +
    'Escreva a próxima mensagem que VOCÊ vai enviar, começando a conversa. ' +
    'Não cumprimente como se fosse o primeiro contato: vocês já se falaram, ' +
    'e o histórico acima é a conversa de vocês.]\n\n';

  const roteiros = {
    ae_lembrete_24h:
      `Lembre a pessoa da aula experimental de ${atividade}${quando ? `, ${quando}` : ''}. ` +
      'Objetivo: confirmar que ela vem, e reforçar em uma linha o que ela ganha indo. ' +
      'Peça uma confirmação simples. Diga o que levar. Curto — duas ou três linhas.',

    ae_pos_aula_presente:
      `Ela FOI à aula de ${atividade}. Pergunte como foi, de forma genuína e específica ` +
      '— não "o que achou?" genérico. Puxe o que ela te contou antes sobre o objetivo dela ' +
      'e conecte com a experiência. Objetivo desta mensagem: colher a impressão, não fechar venda. ' +
      'Uma pergunta só.',

    ae_pos_aula_falta:
      `Ela NÃO compareceu à aula de ${atividade}${quando ? ` (${quando})` : ''}. ` +
      'NÃO cobre e NÃO faça a pessoa se justificar. Trate como algo normal que acontece. ' +
      'Ofereça remarcar, sem pressão, e pergunte que horário seria melhor para ela. ' +
      'Curto e leve.',

    ae_pos_aula_desconhecida:
      `A aula de ${atividade} já passou, mas o sistema não registrou a presença — ` +
      'você NÃO sabe se ela foi. **Não afirme nem sugira que ela faltou.** ' +
      'Pergunte de forma aberta se ela conseguiu vir, de um jeito que funcione nas duas respostas.',

    sondagem_1:
      'Retomada de venda. A pessoa passou pela experiência e ainda não fechou. ' +
      'NÃO reapresente planos e NÃO repita valores que ela já ouviu. ' +
      'A pergunta é outra: **o que falta para ela decidir?** Se ficou algo combinado com o ' +
      'consultor, retome esse ponto pelo nome. Ofereça-se para resolver a dúvida concreta ' +
      'que estiver no caminho. Uma pergunta, tom de quem quer ajudar a decidir, não de quem cobra.',

    sondagem_2:
      'Última retomada. Não insista no que já foi dito e não pressione. ' +
      'Reconheça que ela pode estar sem tempo ou ter mudado de ideia — e diga que tudo bem. ' +
      'Deixe a porta aberta de forma concreta: se quiser experimentar outro horário ou ' +
      'outra modalidade, é só falar. Curto. Se ela não responder, você não escreve de novo.',

    // As duas abaixo são a régua do silêncio. Diferença essencial para as
    // sondagens: aqui a pessoa pode NUNCA ter pisado na academia, e o
    // roteiro não pode supor experiência nenhuma. O que ela tem é o
    // histórico — e é de lá que sai o assunto a retomar.
    silencio_1:
      `A conversa parou${parado ? ` há ${parado}` : ''}. A última mensagem foi ${autoria}, ` +
      'e a pessoa não respondeu. **Não comente o silêncio** — nada de "vi que você sumiu", ' +
      '"ainda está aí?" ou "não tive retorno". Isso cobra, e quem sumiu não deve nada a você.\n' +
      'Retome o ASSUNTO onde ele parou, pelo nome: o que ela disse que queria, a dúvida que ' +
      'ficou aberta, o que ficou de ser confirmado. O histórico acima tem isso — use o que ' +
      'está lá e não invente o que não está.\n' +
      'Uma pergunta só, fácil de responder, sobre o próximo passo concreto. Duas ou três linhas.',

    silencio_2:
      'Última tentativa desta conversa. A pessoa não respondeu à retomada anterior.\n' +
      'NÃO repita o que você já perguntou e NÃO faça a mesma pergunta com outras palavras. ' +
      'Reconheça, sem drama e sem cobrança, que pode não ser o momento dela — e diga que tudo bem.\n' +
      'Feche deixando a porta aberta de um jeito concreto: quando ela quiser retomar, é só ' +
      'escrever aqui. Curto, duas ou três linhas, tom leve. ' +
      'Depois desta você não escreve de novo.',
  };

  const chave = tipo === 'ae_pos_aula'
    ? (presenca === 'presente' ? 'ae_pos_aula_presente'
      : presenca === 'falta' ? 'ae_pos_aula_falta'
      : presenca === 'falta_justificada' ? 'ae_pos_aula_falta'
      : 'ae_pos_aula_desconhecida')
    : tipo;

  return cabeca + (roteiros[chave] || roteiros.sondagem_1);
}

/**
 * Resumo para o consultor, com sugestão do que fazer.
 *
 * Não abre handoff nem pausa a Leia de propósito: o lead segue em conversa
 * automática, e o consultor entra se quiser. Um handoff aqui encheria a
 * fila de casos que ainda não pedem gente.
 */
async function sugerirAoConsultor(lead, { presenca, conversa }) {
  const dica = presenca === 'presente'
    ? 'A pessoa compareceu (confirmado: a sessão foi fechada à mão antes das 22h) — ' +
      'é o melhor momento para entrar com proposta fechada.'
    : presenca === 'falta' || presenca === 'falta_justificada'
      ? 'A pessoa faltou, e alguém marcou isso na sessão. ' +
        'Antes de vender, entender o motivo: horário, insegurança ou desistência.'
      : '⚠️ Presença NÃO confirmada — o EVO traz "presente" por padrão, e esta sessão não foi ' +
        'fechada à mão a tempo. Não dá para saber se ela veio: confirme com a recepção ou com o ' +
        'professor antes de abordar.';

  await funil.registrarEvento(lead.id, {
    type: 'sugestao_consultor',
    actor: 'leia',
    summary: `Pós-experimental (${presenca}). ${dica}`,
    payload: { presenca, conversa },
  });

  await supabase
    .from('crm_leads')
    .update({
      next_action_at: followup.dentroDaJanela(new Date(Date.now() + 24 * 60 * 60 * 1000)).toISOString(),
      next_action_note: `Pós-experimental (${presenca}) — ${dica}`,
    })
    .eq('id', lead.id);
}

// ──────────────────────────────────────────────
// Envio
// ──────────────────────────────────────────────

async function enviarUm(item) {
  const lead = item.lead;

  if (!lead) {
    await followup.registrarEnvio(item.id, { erro: 'lead inexistente' });
    return;
  }

  // 1. O mundo mudou desde o agendamento?
  if (ETAPAS_MORTAS.has(lead.stage)) {
    await followup.cancelar(lead.id, [item.tipo], `lead já está em "${lead.stage}"`);
    return;
  }

  if ((lead.trilha || 'lead') !== TRILHA_DE_VENDA) {
    await followup.cancelar(
      lead.id, [item.tipo],
      `atendimento deixou de ser venda (trilha "${lead.trilha}")`,
    );
    return;
  }

  // Telefone utilizável — conferido AQUI, e não só na varredura, porque
  // esta é a última porta antes de gastar uma chamada ao modelo.
  //
  // Foi o que faltou em 28/08/2026: o primeiro envio da régua de silêncio
  // saiu para `136030220984483`, lixo de cadastro que passava por
  // `startsWith('teste')`. A mensagem foi gerada e paga, e só então a
  // Evolution respondeu `exists: false`. O gate de formato recusa antes do
  // `gerarFollowup`, então o lixo de cadastro deixa de custar dinheiro — e
  // isso vale também para o que já está agendado, que a varredura não
  // alcança mais.
  if (!lead.phone || String(lead.phone).startsWith('teste') || !telefoneValido(lead.phone)) {
    await followup.registrarEnvio(item.id, { erro: `telefone inutilizável (${lead.phone ?? 'ausente'})` });
    logger.warn(`[followup] Lead ${lead.id}: telefone inutilizável (${lead.phone ?? 'ausente'}) — nada enviado`);
    return;
  }

  // A conversa precisa existir e não estar com um humano — se o consultor
  // assumiu, quem fala é ele.
  const { data: conversa } = await supabase
    .from('wa_conversations')
    .select('id, status')
    .eq('contact_id', lead.contact_id)
    .in('status', ['active', 'human'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conversa) {
    await followup.registrarEnvio(item.id, { erro: 'sem conversa aberta' });
    return;
  }

  if (conversa.status === 'human') {
    await followup.cancelar(lead.id, [item.tipo], 'conversa está com o consultor');
    return;
  }

  // 2. O fato que só o EVO sabe — e que ele conta mal.
  let presenca = null;
  let leitura = null;

  if (item.tipo === 'ae_pos_aula') {
    leitura = await evoClient.presencaNaAula({
      idProspect: lead.evo_id_prospect,
      idMember: lead.evo_id_member,
      data: item.contexto?.aula || lead.experimental_at,
    }).catch(() => ({ resultado: 'desconhecida', motivo: 'falha ao consultar o EVO' }));

    presenca = leitura.resultado;
    logger.info(`[followup] Lead ${lead.id}: presença "${presenca}" — ${leitura.motivo}`);

    // Sessão ainda aberta: adiar vale a pena, porque a presença costuma
    // ser fechada ao longo do dia. Mas só até as 22h — depois disso a
    // finalização é automática e deixa de significar presença.
    if (presenca === 'nao_finalizada' && item.tentativas < 3) {
      const novaHora = followup.dentroDaJanela(new Date(Date.now() + 3 * 60 * 60 * 1000));
      await supabase
        .from('crm_followups')
        .update({ scheduled_for: novaHora.toISOString(), tentativas: item.tentativas + 1 })
        .eq('id', item.id);
      logger.info(`[followup] Lead ${lead.id}: sessão ainda aberta, reconsultando às ${novaHora.toISOString()}`);
      return;
    }

    // Esgotou o prazo sem finalização humana: não dá para afirmar nada.
    if (presenca === 'nao_finalizada') presenca = 'desconhecida';
  }

  // 3. Gerar e enviar.
  //
  // `gerarFollowup`, e não `processMessage`: a retomada é uma mensagem de
  // duas ou três linhas que faz uma pergunta, e não precisa da base de
  // conhecimento nem das tools de cadastro para isso. Pelo caminho completo
  // ela custava os ~61.700 tokens de prefixo do atendimento inteiro — o
  // trabalho mais simples do sistema pelo caminho mais caro.
  //
  // A contrapartida: sem a base carregada, o agente é proibido de afirmar
  // preço, horário ou regra (está escrito em `prompts/followup.md`). Os
  // roteiros em `instrucao()` perguntam, não afirmam — mas um roteiro novo
  // que precise de um dado da academia tem que voltar para `processMessage`.
  const resposta = await aiAgent.gerarFollowup({
    instrucao: instrucao(item.tipo, { lead, presenca, contexto: item.contexto }),
    conversationId: conversa.id,
    contactInfo: {
      id: lead.contact_id,
      name: lead.full_name,
      phone: lead.phone,
      is_prospect: !lead.evo_id_member,
      tags: [],
    },
  });

  const texto = resposta?.text?.trim();
  if (!texto) {
    await followup.registrarEnvio(item.id, { presenca, erro: 'agente não gerou texto' });
    return;
  }

  await sendText(lead.phone, texto);

  await saveMessage({
    conversationId: conversa.id,
    contactId: lead.contact_id,
    direction: 'outbound',
    content: texto,
    sentBy: 'bot:followup',
    metadata: { followup: item.tipo, presenca },
    status: 'sent',
  });

  await followup.registrarEnvio(item.id, { mensagem: texto, presenca });
  await followup.registrarNoFunil(
    lead.id, item.tipo,
    `Follow-up "${item.tipo}" enviado${presenca ? ` (presença: ${presenca})` : ''}`,
    { texto: texto.slice(0, 400), leitura }
  );
  await funil.tocarAtividade(lead.id);

  logger.info(`[followup] Lead ${lead.id}: ${item.tipo} enviado`);

  // 4. O que vem depois.
  if (item.tipo === 'ae_pos_aula') {
    await sugerirAoConsultor(lead, { presenca, conversa: conversa.id });

    const proxima = await followup.proximaSondagem(lead);
    if (proxima) await followup.agendar(lead.id, proxima.tipo, proxima.quando, item.contexto);
  } else if (item.tipo.startsWith('sondagem')) {
    const proxima = await followup.proximaSondagem(lead);
    if (proxima) await followup.agendar(lead.id, proxima.tipo, proxima.quando, item.contexto);
  }
}

/**
 * Encerra leads que não responderam depois das duas rodadas.
 *
 * "Perdido" explícito vale mais para o funil do que um lead eternamente
 * "em conversa" que ninguém vai atender — e é o que faz a taxa de
 * conversão significar alguma coisa.
 *
 * Vale para as duas réguas: `sondagem_2` fecha quem sumiu depois da aula,
 * `silencio_2` fecha quem sumiu antes dela. Chegar ao fim das duas rodadas
 * significa a mesma coisa nos dois casos — pedimos duas vezes e não houve
 * resposta —, e um lead precisa poder ser encerrado pelo caminho por onde
 * ele efetivamente andou.
 *
 * A espera é `FOLLOWUP_DIAS_ATE_PERDIDO` (padrão 5) contada do envio da
 * segunda rodada: é o tempo de a pessoa responder à última mensagem, não
 * um tempo de silêncio novo. Encerrar no mesmo dia do envio dá o lead por
 * perdido antes de ele ter tido chance de ler.
 */
async function encerrarSemResposta() {
  const dias = config.followup.diasAtePerdido;
  if (!dias || dias <= 0) return;

  const limite = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('crm_followups')
    .select('lead_id, tipo, sent_at, lead:crm_leads ( id, stage, trilha, contact_id )')
    .in('tipo', ['sondagem_2', 'silencio_2'])
    .eq('status', 'enviado')
    .lte('sent_at', limite)
    .limit(50);

  for (const f of data || []) {
    const lead = f.lead;
    if (!lead || ETAPAS_MORTAS.has(lead.stage)) continue;

    // "Perdido" é veredito de venda. Quem saiu da trilha de venda depois
    // de a rodada ter sido enviada não é venda perdida — é atendimento que
    // acabou, e quem o encerra é o consultor, com `finalizado`.
    if ((lead.trilha || 'lead') !== TRILHA_DE_VENDA) continue;

    // Respondeu depois da última rodada? Então não está perdido.
    //
    // A pergunta é sobre uma MENSAGEM DELE, e por isso é feita em
    // `wa_messages`. Até 31/08/2026 ela era feita em
    // `crm_leads.last_activity_at`, que não significa isso: a coluna é
    // encostada por mudança de etapa, por classificação de contato e por
    // envio nosso — inclusive pelo próprio follow-up. Qualquer uma dessas
    // deixava `last_activity_at` na frente do `sent_at` e o lead passava a
    // ser eternamente "alguém que respondeu", sem nunca ter respondido.
    //
    // Foi o que a classificação retroativa expôs: ela encostou a coluna de
    // 43 leads num dia, e teria isentado todos eles do encerramento.
    if (!lead.contact_id) continue;

    const { data: resposta } = await supabase
      .from('wa_messages')
      .select('id')
      .eq('contact_id', lead.contact_id)
      .eq('direction', 'inbound')
      .gt('created_at', f.sent_at)
      .limit(1);

    if (resposta?.length) continue;

    await funil.mudarEtapa(lead.id, 'perdido', {
      actor: 'sistema',
      motivo: `Sem resposta ${dias} dia(s) depois da segunda rodada de follow-up`,
      campos: { lost_reason: 'Sem resposta após duas rodadas de follow-up' },
    });
    logger.info(`[followup] Lead ${lead.id} marcado como perdido (sem resposta)`);
  }
}

/** Chave do marcador da varredura em `crm_controle`. */
const MARCADOR_VARREDURA = 'followup:ultima_varredura_silencio';

/**
 * Roda a varredura de silêncio no ritmo dela, não no do ciclo.
 *
 * O ciclo lê uma FILA indexada e é barato, por isso roda de 10 em 10 min:
 * o que ele compra é pontualidade no lembrete de 24h. A varredura é outra
 * coisa — percorre os leads vivos da semana e consulta as últimas mensagens
 * de cada um. Silêncio de dois dias não muda de minuto em minuto, então
 * rodar isso a cada ciclo seria pagar o scan seis vezes para descobrir
 * exatamente o mesmo.
 *
 * O relógio fica DENTRO do ciclo, e não num `setInterval` próprio: dois
 * intervalos independentes disparariam a varredura no meio de um ciclo de
 * envio, e as duas mexem nas mesmas linhas.
 *
 * ## Por que o marcador é persistido
 *
 * Ele era `let ultimaVarredura = 0` em memória, e memória zera no boot.
 * Em 28/08/2026 isso foi medido: três deploys no mesmo dia dispararam três
 * varreduras, e o teto de "15 por hora" virou "15 por deploy" — 45
 * mensagens onde a régua promete 15. Com o marcador em `crm_controle`, o
 * relógio sobrevive ao restart e o teto volta a significar o que diz.
 *
 * O carimbo vem ANTES da varredura, não depois. Se ela falhar no meio, o
 * certo é esperar o próximo intervalo em vez de tentar de novo a cada 10
 * min — uma varredura que falha costuma falhar de novo, e insistir a cada
 * ciclo só multiplica o efeito de um EVO fora do ar.
 */
async function talvezVarrer() {
  const cfg = config.followup.silencio;
  if (!cfg.habilitado || cfg.minutos <= 0) return;
  if (!(await controle.passouDe(MARCADOR_VARREDURA, cfg.minutos))) return;

  await controle.carimbarMarcador(MARCADOR_VARREDURA, { iniciada_em: new Date().toISOString() });
  await followup.varrerSilenciosos().catch(err =>
    logger.error('[followup] Varredura de silêncio falhou:', err.message));
}

async function ciclo() {
  if (rodando) return;
  rodando = true;

  try {
    // Ordem importa: varrer ANTES de ler a fila faz a cutucada recém-agendada
    // que já caiu na janela sair neste mesmo ciclo, em vez de esperar o
    // próximo. Como `agendar` é idempotente e a varredura só olha o que já
    // está gravado, não há risco de agendar e enviar em duplicidade.
    await talvezVarrer();

    const fila = await followup.vencidos(20);
    for (const item of fila) {
      try {
        await enviarUm(item);
      } catch (err) {
        logger.error(`[followup] Falha no follow-up ${item.id}:`, err.message);
        await followup.registrarTentativa(item.id, item.tentativas || 0, err.message);
      }
    }
    await encerrarSemResposta();

    // O fim de linha da outra trilha. Fica no mesmo ciclo porque é a mesma
    // pergunta feita do outro lado — "isto ainda está acontecendo?" —, e
    // porque é uma consulta indexada, sem chamada externa nenhuma.
    await funil.encerrarRelacionamentosParados().catch(err =>
      logger.error('[followup] Falha ao encerrar relacionamentos parados:', err.message));
  } catch (err) {
    logger.error('[followup] Ciclo falhou:', err.message);
  } finally {
    rodando = false;
  }
}

export async function startFollowupWorker() {
  const minutos = config.followup.minutos;

  if (!config.crm.habilitado || minutos <= 0) {
    logger.info('[followup] Worker desligado (FOLLOWUP_MINUTOS=0 ou CRM desabilitado)');
    return;
  }

  const { error } = await supabase.from('crm_followups').select('id').limit(1);
  if (error) {
    logger.warn('[followup] Não iniciado: crm_followups ainda não responde. ' +
      'Rode a migration 003 e reinicie o serviço.');
    return;
  }

  const silencio = config.followup.silencio;
  if (silencio.habilitado && silencio.minutos > 0) {
    logger.info(`[followup] Régua de silêncio ligada: ${silencio.dias} dia(s) parado, ` +
      `janela de ${silencio.janelaDias} dia(s), até ${silencio.lote} por varredura ` +
      `a cada ${silencio.minutos} min`);
  } else {
    logger.info('[followup] Régua de silêncio desligada (FOLLOWUP_SILENCIO_HABILITADO=false ' +
      'ou FOLLOWUP_SILENCIO_MINUTOS=0)');
  }

  logger.info(`[followup] Worker iniciado (ciclo a cada ${minutos} min)`);
  setTimeout(ciclo, 90_000);
  setInterval(ciclo, minutos * 60_000);
}
