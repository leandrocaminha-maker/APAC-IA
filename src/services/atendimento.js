/**
 * src/services/atendimento.js
 * As duas pendências que o painel precisa gritar.
 *
 * O handoff sempre teve um buraco no meio: a Leia desiste, grava o
 * briefing, cala o bot — e ninguém é avisado. O lead entra em
 * `aguardando_consultor` e fica lá até alguém abrir a aba certa. Estas
 * duas contas existem para o painel poder mudar de cor quando isso
 * acontece.
 *
 * **As duas pendências PARTICIONAM a fila, não se sobrepõem:**
 *
 *   aguardandoConsultor → handoff aberto, ninguém assumiu
 *   aguardandoResposta  → alguém assumiu, e o cliente falou por último
 *
 * A mesma conversa cair nas duas faria o consultor contar duas vezes o
 * mesmo problema. Por isso a segunda conta ignora quem ainda está na
 * primeira: são estágios diferentes do mesmo atendimento, e cada cartão
 * responde uma pergunta diferente ("quem ninguém pegou?" e "quem estou
 * deixando no vácuo?").
 *
 * Por que a segunda não sai de `wa_conversations.status`: `human` só diz
 * que o bot está calado, não quem falou por último. Quem responde isso é
 * a direção da última mensagem — daí a leitura de `wa_messages`.
 */
import { supabase } from '../lib/supabase.js';

/** Conversas do simulador não são atendimento — ficam fora das contas. */
const CANAL_SIMULADOR = 'web-test';

/** Teto de conversas examinadas por chamada. A fila real é muito menor. */
const TETO_CONVERSAS = 200;

/** Teto de mensagens lidas para descobrir a última de cada conversa. */
const TETO_MENSAGENS = 1000;

/** Folga na janela de leitura, para absorver diferença de relógio. */
const MARGEM_MS = 5 * 60 * 1000;

function trecho(texto, max = 90) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Fila de handoff: leads em `aguardando_consultor`.
 *
 * Ordenado por `stage_since` crescente — quem espera há mais tempo vem
 * primeiro, que é a ordem em que a fila deveria ser atendida.
 *
 * Devolve também `contatos`, os `contact_id` da fila inteira (não só os
 * exibidos): é com essa lista que `aguardandoResposta` se mantém
 * disjunta.
 */
export async function filaDeConsultor({ limite = 12 } = {}) {
  const { data, count, error } = await supabase
    .from('crm_leads')
    .select(
      'id, full_name, phone, stage_since, contact_id, contato:wa_contacts ( id, name, phone )',
      { count: 'exact' },
    )
    .eq('stage', 'aguardando_consultor')
    .order('stage_since', { ascending: true })
    .limit(TETO_CONVERSAS);

  if (error) throw new Error(`falha ao ler a fila de consultor: ${error.message}`);

  const leads = data || [];

  return {
    total: count ?? leads.length,
    maisAntigoEm: leads[0]?.stage_since || null,
    contatos: leads.map(l => l.contact_id).filter(Boolean),
    itens: leads.slice(0, limite).map(l => ({
      leadId: l.id,
      nome: l.full_name || l.contato?.name || null,
      telefone: l.phone || l.contato?.phone || null,
      desde: l.stage_since,
    })),
  };
}

/**
 * Contatos com o consultor que estão esperando resposta.
 *
 * Critério: conversa com o bot calado (`status = 'human'`) cuja **última
 * mensagem é do cliente**. Se a última é nossa, a bola está com ele, não
 * conosco.
 *
 * A janela de leitura das mensagens começa na conversa parada há mais
 * tempo. `last_message` é gravado quando a mensagem do cliente chega
 * (getOrCreateConversation) e quando o consultor responde pelo painel,
 * então toda conversa candidata tem pelo menos uma mensagem dentro da
 * janela — é o que permite achar a última de cada uma em UMA consulta,
 * em vez de uma por conversa.
 */
export async function aguardandoResposta({ ignorarContatos = [], limite = 12 } = {}) {
  const { data: conversas, error } = await supabase
    .from('wa_conversations')
    .select('id, contact_id, assigned_to, last_message, started_at, contato:wa_contacts ( id, name, phone )')
    .eq('status', 'human')
    .neq('channel', CANAL_SIMULADOR)
    .order('last_message', { ascending: false })
    .limit(TETO_CONVERSAS);

  if (error) throw new Error(`falha ao ler conversas com consultor: ${error.message}`);

  const naFila = new Set(ignorarContatos);
  const candidatas = (conversas || []).filter(c => !naFila.has(c.contact_id));
  const vazio = { total: 0, maisAntigoEm: null, itens: [] };
  if (!candidatas.length) return vazio;

  const inicio = candidatas.reduce((menor, c) => {
    const t = new Date(c.last_message || c.started_at).getTime();
    return Number.isFinite(t) && t < menor ? t : menor;
  }, Date.now());

  const { data: mensagens } = await supabase
    .from('wa_messages')
    .select('conversation_id, direction, content, created_at')
    .in('conversation_id', candidatas.map(c => c.id))
    .gte('created_at', new Date(inicio - MARGEM_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(TETO_MENSAGENS);

  // Ordenado do mais novo para o mais antigo: a primeira ocorrência de
  // cada conversa é a última mensagem dela.
  const ultima = new Map();
  for (const m of mensagens || []) {
    if (!ultima.has(m.conversation_id)) ultima.set(m.conversation_id, m);
  }

  const itens = [];
  for (const c of candidatas) {
    const m = ultima.get(c.id);
    if (!m || m.direction !== 'inbound') continue;
    itens.push({
      conversaId: c.id,
      nome: c.contato?.name || null,
      telefone: c.contato?.phone || null,
      consultor: c.assigned_to || null,
      desde: m.created_at,
      previa: trecho(m.content),
    });
  }

  itens.sort((a, b) => new Date(a.desde) - new Date(b.desde));

  return {
    total: itens.length,
    maisAntigoEm: itens[0]?.desde || null,
    itens: itens.slice(0, limite),
  };
}

/** As duas contas, já disjuntas, do jeito que o painel consome. */
export async function pendencias({ limite = 12 } = {}) {
  const fila = await filaDeConsultor({ limite });
  const resposta = await aguardandoResposta({ ignorarContatos: fila.contatos, limite });

  const { contatos, ...semContatos } = fila;
  return { aguardandoConsultor: semContatos, aguardandoResposta: resposta };
}

export const atendimento = { filaDeConsultor, aguardandoResposta, pendencias };
