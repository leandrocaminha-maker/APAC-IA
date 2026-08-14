/**
 * src/services/ai-tools.js
 * Definição das ferramentas (function calling) disponíveis para o agente Gemini.
 *
 * Cada ferramenta tem:
 * - declaration: schema para o Gemini (nome, descrição, parâmetros)
 * - handler: função que executa a ação real
 */
import { evoClient } from './evo-client.js';
import { logger } from '../lib/logger.js';

// ──────────────────────────────────────────────
// Declarações de tools para o Gemini
// ──────────────────────────────────────────────

export const toolDeclarations = [
  {
    name: 'buscar_planos',
    description: 'Busca os planos e serviços disponíveis na academia com preços atualizados. Use sempre que o cliente perguntar sobre valores, planos ou mensalidades.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'buscar_horarios',
    description: 'Busca a grade horária de aulas da academia. Use quando o cliente perguntar sobre horários disponíveis.',
    parameters: {
      type: 'OBJECT',
      properties: {
        modalidade: {
          type: 'STRING',
          description: 'Nome da modalidade para filtrar (ex: "natação infantil", "hidroginástica"). Opcional.',
        },
      },
    },
  },
  {
    name: 'buscar_modalidades',
    description: 'Lista as modalidades/atividades oferecidas pela academia.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'cadastrar_prospect',
    description: 'Cadastra um potencial cliente (prospect) no sistema da academia. Use quando o cliente demonstrar interesse e fornecer dados básicos.',
    parameters: {
      type: 'OBJECT',
      properties: {
        nome: {
          type: 'STRING',
          description: 'Nome completo do prospect',
        },
        telefone: {
          type: 'STRING',
          description: 'Telefone do prospect (já temos do WhatsApp)',
        },
        email: {
          type: 'STRING',
          description: 'E-mail do prospect (se fornecido)',
        },
        interesse: {
          type: 'STRING',
          description: 'Modalidade de interesse principal',
        },
      },
      required: ['nome', 'telefone'],
    },
  },
  {
    name: 'agendar_aula_experimental',
    description: 'Agenda uma aula experimental gratuita para o prospect. Use quando o cliente aceitar fazer uma aula experimental.',
    parameters: {
      type: 'OBJECT',
      properties: {
        nome: {
          type: 'STRING',
          description: 'Nome do prospect',
        },
        telefone: {
          type: 'STRING',
          description: 'Telefone do prospect',
        },
        modalidade: {
          type: 'STRING',
          description: 'Modalidade desejada',
        },
        data_preferencia: {
          type: 'STRING',
          description: 'Data de preferência no formato YYYY-MM-DD',
        },
      },
      required: ['nome', 'telefone', 'modalidade'],
    },
  },
  {
    name: 'emitir_voucher',
    description: 'Gera um voucher de desconto ou cortesia para o prospect. Use com moderação e apenas quando for estrategicamente relevante para fechar uma venda.',
    parameters: {
      type: 'OBJECT',
      properties: {
        tipo: {
          type: 'STRING',
          description: 'Tipo do voucher: "desconto_percentual", "desconto_fixo", "aula_gratis"',
          enum: ['desconto_percentual', 'desconto_fixo', 'aula_gratis'],
        },
        valor: {
          type: 'NUMBER',
          description: 'Valor do desconto (percentual ou fixo em reais)',
        },
        validade_dias: {
          type: 'NUMBER',
          description: 'Dias de validade do voucher',
        },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'transferir_para_humano',
    description: 'Transfere a conversa para um consultor humano. Use quando: reclamação, negociação especial, assunto financeiro complexo, ou quando o cliente pedir expressamente.',
    parameters: {
      type: 'OBJECT',
      properties: {
        motivo: {
          type: 'STRING',
          description: 'Motivo da transferência',
        },
      },
      required: ['motivo'],
    },
  },
];

// ──────────────────────────────────────────────
// Handlers das tools
// ──────────────────────────────────────────────

const handlers = {
  async buscar_planos() {
    try {
      const services = await evoClient.getServices({ take: 100 });
      // Filtra apenas serviços ativos e formata
      const planos = (Array.isArray(services) ? services : [])
        .filter(s => s.isActive !== false)
        .map(s => ({
          nome: s.name || s.description,
          valor: s.price || s.value,
          descricao: s.description,
          periodicidade: s.periodicity,
        }));

      return {
        success: true,
        planos,
        mensagem: planos.length > 0
          ? `Encontrei ${planos.length} plano(s) disponível(is).`
          : 'Nenhum plano encontrado no momento.',
      };
    } catch (err) {
      logger.error('[ai-tools] buscar_planos:', err.message);
      return { success: false, mensagem: 'Não consegui consultar os planos no momento. Sugira que o cliente entre em contato diretamente.' };
    }
  },

  async buscar_horarios(args) {
    try {
      const params = {};
      // Se especificou modalidade, tenta filtrar
      const schedule = await evoClient.getSchedule(params);
      const items = Array.isArray(schedule) ? schedule : [];

      // Filtra por modalidade se fornecida
      let filtered = items;
      if (args?.modalidade) {
        const term = args.modalidade.toLowerCase();
        filtered = items.filter(s =>
          (s.activityName || s.name || '').toLowerCase().includes(term)
        );
      }

      return {
        success: true,
        horarios: filtered.slice(0, 20).map(s => ({
          atividade: s.activityName || s.name,
          dia: s.dayOfWeek || s.weekDay,
          inicio: s.startTime || s.start,
          fim: s.endTime || s.end,
          professor: s.employeeName || s.teacher,
        })),
        total: filtered.length,
      };
    } catch (err) {
      logger.error('[ai-tools] buscar_horarios:', err.message);
      return { success: false, mensagem: 'Não consegui consultar os horários no momento.' };
    }
  },

  async buscar_modalidades() {
    try {
      const activities = await evoClient.getActivities({ take: 100 });
      const items = (Array.isArray(activities) ? activities : [])
        .filter(a => a.isActive !== false)
        .map(a => ({
          nome: a.name || a.description,
          descricao: a.description,
        }));

      return { success: true, modalidades: items };
    } catch (err) {
      logger.error('[ai-tools] buscar_modalidades:', err.message);
      return { success: false, mensagem: 'Não consegui consultar as modalidades no momento.' };
    }
  },

  async cadastrar_prospect(args) {
    try {
      const nameParts = (args.nome || '').trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      const result = await evoClient.createProspect({
        firstName,
        lastName,
        phone: args.telefone,
        email: args.email || null,
        notes: `Interesse: ${args.interesse || 'Não especificado'}. Cadastrado via WhatsApp Bot.`,
      });

      return {
        success: true,
        mensagem: `Prospect "${args.nome}" cadastrado com sucesso!`,
        idMember: result?.idMember || null,
      };
    } catch (err) {
      logger.error('[ai-tools] cadastrar_prospect:', err.message);
      return { success: false, mensagem: 'Não consegui cadastrar o prospect no momento. Vou anotar os dados para cadastro manual.' };
    }
  },

  async agendar_aula_experimental(args) {
    try {
      // Primeiro, busca ou cria o prospect
      let prospect = null;
      const members = await evoClient.searchMembers({ phone: args.telefone });
      if (Array.isArray(members) && members.length > 0) {
        prospect = members[0];
      } else {
        // Cadastra como prospect
        const nameParts = (args.nome || '').trim().split(/\s+/);
        prospect = await evoClient.createProspect({
          firstName: nameParts[0] || '',
          lastName: nameParts.slice(1).join(' ') || '',
          phone: args.telefone,
        });
      }

      // Tenta agendar a aula experimental
      const result = await evoClient.scheduleExperimentalClass({
        idMember: prospect?.idMember || prospect?.id,
        date: args.data_preferencia || new Date().toISOString().slice(0, 10),
      });

      return {
        success: true,
        mensagem: `Aula experimental de ${args.modalidade} agendada para ${args.nome}!`,
        detalhes: result,
      };
    } catch (err) {
      logger.error('[ai-tools] agendar_aula_experimental:', err.message);
      return {
        success: false,
        mensagem: 'Não consegui agendar automaticamente. Vou registrar seu interesse e um consultor entrará em contato para confirmar o melhor horário.',
      };
    }
  },

  async emitir_voucher(args) {
    // Por ora, gera um código de voucher local (sem integração EVO para isso)
    const code = `AP${Date.now().toString(36).toUpperCase()}`;
    const validade = new Date();
    validade.setDate(validade.getDate() + (args.validade_dias || 7));

    return {
      success: true,
      voucher: {
        codigo: code,
        tipo: args.tipo,
        valor: args.valor || null,
        validade: validade.toISOString().slice(0, 10),
      },
      mensagem: `Voucher ${code} gerado com sucesso! Válido até ${validade.toLocaleDateString('pt-BR')}.`,
    };
  },

  async transferir_para_humano(args) {
    // Retorna sinal para o agente pausar o bot
    return {
      success: true,
      action: 'handoff',
      motivo: args.motivo,
      mensagem: 'Transferindo para um consultor humano. Aguarde um momento.',
    };
  },
};

/**
 * Executa uma tool pelo nome.
 * @param {string} name - Nome da ferramenta
 * @param {object} args - Argumentos passados pelo Gemini
 * @returns {Promise<object>} Resultado da execução
 */
export async function executeTool(name, args) {
  const handler = handlers[name];
  if (!handler) {
    logger.warn(`[ai-tools] Tool desconhecida: ${name}`);
    return { success: false, mensagem: `Ferramenta "${name}" não encontrada.` };
  }

  logger.info(`[ai-tools] Executando tool: ${name}`, JSON.stringify(args));
  return handler(args);
}
