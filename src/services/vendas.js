/**
 * src/services/vendas.js
 * O registro das vendas de plano, por canal, e os números do período.
 *
 * Toda venda de plano pago que chega do EVO vira uma linha em `crm_vendas`,
 * classificada na chegada: quem comprou (novo, ex-aluno, aluno ativo), por
 * onde chegou (WhatsApp ou balcão), quem vendeu. E o atendimento do
 * WhatsApp que ela fecha vira ganho, com o valor da venda.
 *
 * ## Por que existe
 *
 * Até 26/10/2026 o funil só sabia de venda quando o webhook achava o lead
 * pelo número de prospect. A venda de balcão chega com o número de ALUNO
 * novo, e o lead não conhecia esse número: de 56 vendas a novos e
 * ex-alunos que tinham falado pelo WhatsApp, 20 apareciam como ganho. E a
 * venda de quem nunca escreveu não aparecia em lugar nenhum, então não dava
 * para comparar os dois caminhos.
 *
 * ## O custo, em consultas ao EVO
 *
 * Cliente novo: nenhuma. O `CreateMember` chega antes da venda, já com o
 * celular, e "cadastro de hoje" já responde que é novo.
 * Quem já tinha cadastro de aluno: uma (o histórico de contratos, que é o
 * que separa ex-aluno de aluno ativo), e mais uma se nenhum atendimento
 * estiver ligado a ele (o celular). Mais a lista de funcionários, uma vez
 * por dia.
 */
import { config } from '../config.js';
import { supabase, lerTodas } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { evoClient } from './evo-client.js';
import { mudarEtapa, registrarEvento, leadsDaPessoa } from './funil.js';
import {
  planoDaVenda, telefonesDoMembro, classificarComprador, canalDaVenda,
  escolherLeadDoGanho, rotuloDoVendedor, dataDoEvo,
} from './vendas-regras.js';

const DIA_MS = 24 * 60 * 60 * 1000;

/** Cadastro de aluno criado até dois dias antes da venda é cliente novo. */
const CADASTRO_RECENTE_MS = 2 * DIA_MS;

// ──────────────────────────────────────────────
// De onde vem cada informação
// ──────────────────────────────────────────────

let funcionarios = { lidoEm: 0, nomes: new Map() };

/**
 * As fontes da análise, num objeto só.
 *
 * O webhook usa estas. A reconstrução do histórico troca as que custam
 * consulta ao EVO por um cache, para analisar centenas de vendas sem
 * repetir pergunta — e o resto da decisão continua sendo o mesmo código.
 */
export const fontesPadrao = {
  /** O `CreateMember` guardado: celular e data do cadastro, sem consulta. */
  async membroCriado(idMember) {
    const { data } = await supabase
      .from('crm_evo_webhook_events')
      .select('detail')
      .eq('event_type', 'CreateMember')
      .eq('id_record', Number(idMember))
      .not('detail', 'is', null)
      .limit(1);
    const d = data?.[0]?.detail;
    return d ? { registerDate: d.registerDate || null, telefones: telefonesDoMembro(d) } : null;
  },

  /** Histórico de contratos, normalizado. Uma consulta. */
  async contratos(idMember) {
    const lista = await evoClient.buscarContratosDoMembro(idMember);
    return lista.map(c => ({
      idSale: c.idSale,
      ini: c.membershipStart,
      fim: c.cancelDate || c.membershipEnd,
      valor: c.saleValue,
    }));
  },

  /** Celulares do cadastro de aluno. Uma consulta. */
  async telefones(idMember) {
    return telefonesDoMembro(await evoClient.buscarMembroPorId(idMember));
  },

  /** Nome do vendedor. A lista é lida uma vez por dia. */
  async vendedor(idEmployee) {
    if (idEmployee == null) return null;
    if (Date.now() - funcionarios.lidoEm > DIA_MS) {
      try {
        const lista = await evoClient.listarFuncionarios();
        funcionarios = { lidoEm: Date.now(), nomes: new Map(lista.map(f => [Number(f.idEmployee), f.name])) };
      } catch (err) {
        // Sem nome hoje não impede registrar a venda; tenta de novo amanhã.
        funcionarios.lidoEm = Date.now();
        logger.warn('[vendas] Não deu para ler os funcionários do EVO:', err.message);
      }
    }
    return rotuloDoVendedor(funcionarios.nomes.get(Number(idEmployee)));
  },

  leadsDaPessoa,
};

// ──────────────────────────────────────────────
// Análise e aplicação
// ──────────────────────────────────────────────

/**
 * Lê uma venda do EVO e decide tudo sobre ela, sem gravar nada.
 *
 * @returns {Promise<null | {
 *   venda: object, plano: object, leads: object[],
 *   escolha: {lead: object, acao: string} | null,
 * }>}  null quando a venda não é de plano pago.
 */
export async function analisarVenda(detalhe, { fontes = fontesPadrao, eventoId = null } = {}) {
  const plano = planoDaVenda(detalhe);
  const idMember = detalhe?.idMember ?? detalhe?.IdMember ?? null;
  if (!plano || !idMember) return null;

  const idSale = detalhe.idSale ?? null;
  const quando = detalhe.saleDate || detalhe.saleDateServer
    ? dataDoEvo(detalhe.saleDate || detalhe.saleDateServer)
    : new Date();

  // Cliente novo se o cadastro de aluno nasceu junto com a venda.
  const criado = await fontes.membroCriado(idMember);
  const recente = criado?.registerDate
    && Math.abs(quando.getTime() - dataDoEvo(criado.registerDate).getTime()) <= CADASTRO_RECENTE_MS;

  let comprador = 'novo';
  let mesesSemContrato = null;
  if (!recente) {
    const contratos = await fontes.contratos(idMember);
    ({ comprador, mesesSemContrato } = classificarComprador({
      contratos, idSale, quando, mesesReativacao: config.evo.mesesReativacao,
    }));
  }

  // Os atendimentos dela. O celular do EVO só é pedido quando nada no
  // banco liga a pessoa a um atendimento.
  let telefones = criado?.telefones || [];
  let leads = await fontes.leadsDaPessoa({ idMember, idProspect: detalhe.idProspect, telefones });
  if (!leads.length && !telefones.length) {
    telefones = await fontes.telefones(idMember);
    if (telefones.length) leads = await fontes.leadsDaPessoa({ telefones });
  }

  const canal = canalDaVenda(leads, quando);
  const escolha = escolherLeadDoGanho(leads, { quando, comprador });

  return {
    plano,
    leads,
    escolha,
    venda: {
      evo_id_sale: Number(idSale),
      evo_id_member: Number(idMember),
      sale_at: quando.toISOString(),
      valor: plano.valor,
      planos: plano.planos,
      comprador,
      meses_sem_contrato: mesesSemContrato,
      canal,
      lead_id: escolha?.lead?.id ?? null,
      vendedor_id: detalhe.idEmployeeSale ?? null,
      vendedor_nome: await fontes.vendedor(detalhe.idEmployeeSale),
      origem_evo: detalhe.saleSource ?? null,
      telefone: telefones[0] || escolha?.lead?.phone || null,
      webhook_event_id: eventoId,
    },
  };
}

/** Avisa uma vez por processo, em vez de a cada venda. */
let avisouMigration = false;

/** Grava a linha da venda. Reentrega do mesmo webhook atualiza a mesma linha. */
export async function gravarVenda(venda) {
  const { error } = await supabase
    .from('crm_vendas')
    .upsert({ ...venda, updated_at: new Date().toISOString() }, { onConflict: 'evo_id_sale' });

  if (!error) return true;
  if (error.code === 'PGRST205' || error.code === '42P01') {
    if (!avisouMigration) {
      logger.error('[vendas] A tabela crm_vendas não existe — rode a migration 020. ' +
        'O lead continua virando ganho, mas a venda não fica registrada.');
      avisouMigration = true;
    }
  } else {
    logger.error(`[vendas] Falha ao gravar a venda ${venda.evo_id_sale}:`, error.message);
  }
  return false;
}

/**
 * Aplica a decisão no atendimento: ganho, valor que faltava, ou só o vínculo.
 *
 * `ganho` passa por `mudarEtapa`, como todo avanço: é o que cancela os
 * follow-ups, marca o contato como aluno e deixa o evento no razão.
 */
export async function aplicarNoLead(analise, { actor }) {
  const { escolha, venda, plano } = analise;
  if (!escolha) return null;

  const { lead, acao } = escolha;
  const data = venda.sale_at.slice(0, 10).split('-').reverse().join('/');
  const resumo = `${plano.planos.join(', ')} — R$ ${venda.valor.toFixed(2)}`;

  if (acao === 'ganho') {
    return mudarEtapa(lead, 'ganho', {
      actor,
      motivo: `Venda no EVO em ${data}: ${resumo}`,
      campos: {
        sale_at: venda.sale_at,
        sale_value: venda.valor,
        evo_id_sale: venda.evo_id_sale,
        evo_id_member: lead.evo_id_member || venda.evo_id_member,
      },
      payload: { idSale: venda.evo_id_sale, comprador: venda.comprador, canal: venda.canal },
    });
  }

  if (acao === 'completar') {
    const { data: linhas, error } = await supabase
      .from('crm_leads')
      .update({
        sale_at: venda.sale_at,
        sale_value: venda.valor,
        evo_id_sale: venda.evo_id_sale,
        evo_id_member: lead.evo_id_member || venda.evo_id_member,
      })
      .eq('id', lead.id)
      .is('sale_value', null)
      .select();
    if (error) {
      logger.error(`[vendas] Não deu para gravar o valor no lead ${lead.id}:`, error.message);
      return lead;
    }
    if (linhas?.length) {
      await registrarEvento(lead.id, {
        type: 'venda_valor',
        actor,
        summary: `Venda no EVO em ${data}: ${resumo}`,
        payload: { idSale: venda.evo_id_sale },
      });
    }
    return linhas?.[0] || lead;
  }

  // `vincular`: o atendimento já é ganho com valor. É o segundo plano da
  // família. A venda fica registrada em `crm_vendas`; no razão, uma linha.
  await registrarEvento(lead.id, {
    type: 'venda_adicional',
    actor,
    summary: `Mais uma venda no EVO em ${data}: ${resumo}`,
    payload: { idSale: venda.evo_id_sale },
  });
  return lead;
}

/**
 * A venda de plano que chegou pelo webhook: analisa, registra e fecha o lead.
 *
 * Nunca lança: a venda já aconteceu no EVO, e uma falha aqui não pode
 * derrubar o processamento do evento.
 *
 * @returns {Promise<object|null>} o lead que a venda fechou, se houver
 */
export async function registrarVendaDoEvo(detalhe, evento = null, { actor = 'evo-webhook' } = {}) {
  try {
    const analise = await analisarVenda(detalhe, { eventoId: evento?.id ?? null });
    if (!analise) return null;

    await gravarVenda(analise.venda);
    const lead = await aplicarNoLead(analise, { actor });

    logger.info(
      `[vendas] Venda ${analise.venda.evo_id_sale}: ${analise.venda.comprador}, ${analise.venda.canal}, ` +
      `R$ ${analise.venda.valor.toFixed(2)}` +
      (analise.escolha ? ` → lead ${analise.escolha.lead.id} (${analise.escolha.acao})` : ' → sem atendimento')
    );
    return lead;
  } catch (err) {
    logger.error(`[vendas] Falha ao registrar a venda ${detalhe?.idSale}:`, err.message);
    return null;
  }
}

/**
 * Liga ao lead uma venda já registrada que tinha ficado sem atendimento.
 *
 * É o poller que chama, quando a conversão do prospect revela de quem era a
 * venda que o webhook não conseguiu ligar. O canal passa a WhatsApp porque,
 * se há lead, a pessoa falou com a gente por lá.
 */
export async function vincularVendaAoLead(idSale, lead) {
  if (!idSale || !lead?.id) return;
  const { error } = await supabase
    .from('crm_vendas')
    .update({ lead_id: lead.id, canal: 'whatsapp', updated_at: new Date().toISOString() })
    .eq('evo_id_sale', Number(idSale))
    .is('lead_id', null);
  if (error && error.code !== 'PGRST205') {
    logger.warn(`[vendas] Não deu para ligar a venda ${idSale} ao lead ${lead.id}:`, error.message);
  }
}

// ──────────────────────────────────────────────
// Números do período
// ──────────────────────────────────────────────

const vazio = () => ({ vendas: 0, valor: 0 });
function somar(alvo, valor) {
  alvo.vendas++;
  alvo.valor = Math.round((alvo.valor + Number(valor || 0)) * 100) / 100;
}

/**
 * O desempenho de cada caminho do funil num período.
 *
 * Vendas: por data da venda. Funil do WhatsApp: os atendimentos de venda
 * que COMEÇARAM no período, e até onde cada um chegou — é uma coorte, para
 * que o atendimento de setembro que fechou em outubro não infle outubro.
 *
 * "Foi à academia" é ter a aula experimental realizada (o aviso do EVO) ou
 * ter comprado. O aviso só existe desde 27/10/2026; antes disso, só a
 * compra conta.
 *
 * @param {{de: string, ate: string}} periodo  ISO, já em horário de São Paulo
 */
export async function metricasDoPeriodo({ de, ate }) {
  const [vendasR, leadsR, cadastrosR] = await Promise.all([
    lerTodas(() => supabase
      .from('crm_vendas')
      .select('valor, comprador, canal, vendedor_nome, origem_evo, lead_id')
      .gte('sale_at', de).lte('sale_at', ate)),
    lerTodas(() => supabase
      .from('crm_leads')
      .select('stage, experimental_at, experimental_status')
      .eq('trilha', 'lead').eq('source', 'whatsapp')
      .gte('created_at', de).lte('created_at', ate)),
    lerTodas(() => supabase
      .from('crm_evo_webhook_events')
      .select('lead_id')
      .like('event_type', '%prospect_registration')
      .gte('created_at', de).lte('created_at', ate)),
  ]);

  const tabelaFalta = vendasR.error && ['PGRST205', '42P01'].includes(vendasR.error.code);
  if (vendasR.error && !tabelaFalta) throw new Error(`falha ao ler as vendas: ${vendasR.error.message}`);
  if (leadsR.error) throw new Error(`falha ao ler os leads: ${leadsR.error.message}`);

  const canais = {
    whatsapp: { novo: vazio(), ex_aluno: vazio(), total: vazio() },
    balcao: { novo: vazio(), ex_aluno: vazio(), total: vazio() },
  };
  const renovacoes = { whatsapp: vazio(), balcao: vazio(), total: vazio() };
  const porVendedor = new Map();

  for (const v of vendasR.data || []) {
    const nome = v.vendedor_nome || 'Sem vendedor';
    if (!porVendedor.has(nome)) porVendedor.set(nome, { vendedor: nome, funil: vazio(), renovacoes: vazio() });
    const linha = porVendedor.get(nome);

    if (v.comprador === 'aluno_ativo') {
      somar(renovacoes[v.canal], v.valor);
      somar(renovacoes.total, v.valor);
      somar(linha.renovacoes, v.valor);
    } else {
      somar(canais[v.canal][v.comprador], v.valor);
      somar(canais[v.canal].total, v.valor);
      somar(linha.funil, v.valor);
    }
  }

  const leads = leadsR.data || [];
  const funilWhatsapp = {
    leads: leads.length,
    experimentalAgendada: leads.filter(l => l.experimental_at).length,
    foiAAcademia: leads.filter(l => l.experimental_status === 'realizada' || l.stage === 'ganho').length,
    venda: leads.filter(l => l.stage === 'ganho').length,
  };

  const cadastros = cadastrosR.data || [];

  return {
    periodo: { de, ate },
    registroDeVendas: !tabelaFalta,
    canais,
    renovacoes,
    porVendedor: [...porVendedor.values()].sort((a, b) => b.funil.valor - a.funil.valor),
    funilWhatsapp,
    cadastrosDeOportunidade: {
      total: cadastros.length,
      semWhatsapp: cadastros.filter(c => !c.lead_id).length,
    },
  };
}

export const vendas = {
  fontesPadrao, analisarVenda, gravarVenda, aplicarNoLead,
  registrarVendaDoEvo, vincularVendaAoLead, metricasDoPeriodo,
};
