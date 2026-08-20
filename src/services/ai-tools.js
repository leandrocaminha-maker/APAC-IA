/**
 * src/services/ai-tools.js
 * Definição das ferramentas (tool use) disponíveis para o agente Claude.
 *
 * Cada ferramenta tem:
 * - declaration: schema JSON (nome, descrição, input_schema)
 * - handler: função que executa a ação real
 *
 * NOTA — consultas de informação ao EVO desativadas:
 * As tools `buscar_planos`, `buscar_horarios` e `buscar_modalidades` foram
 * removidas. Planos, valores, modalidades e grade horária agora vêm dos
 * arquivos em src/prompts/knowledge/, que são carregados no contexto do
 * prompt a cada resposta — mais preciso e com texto sob nosso controle.
 *
 * NOTA — tools de ação pausadas (ver PAUSED_TOOLS abaixo):
 * As ações que escrevem no EVO e a emissão de voucher estão pausadas até
 * serem estudadas com calma. O código foi mantido; só não é oferecido ao
 * modelo. Neste momento o agente é conversacional + handoff.
 */
import { evoClient } from './evo-client.js';
import { logger } from '../lib/logger.js';

// ──────────────────────────────────────────────
// Tools pausadas
//
// Não são declaradas ao Claude nem executáveis. Para reativar uma delas,
// basta remover o nome desta lista — declaração e handler continuam prontos.
//
// - emitir_voucher ......... gera código que não é persistido em lugar nenhum;
//                            o cliente receberia um voucher irresgatável.
// - cadastrar_prospect ..... usa POST /api/v1/members, que cria MEMBRO em vez
//                            de prospect; o correto é POST /api/v1/prospects.
// - agendar_aula_experimental  depende do endpoint acima e nunca foi validado
//                            contra o EVO (é escrita em produção).
// ──────────────────────────────────────────────

const PAUSED_TOOLS = new Set([
  'emitir_voucher',
  'cadastrar_prospect',
  'agendar_aula_experimental',
]);

// ──────────────────────────────────────────────
// Declarações de tools
// ──────────────────────────────────────────────

const allToolDeclarations = [
  {
    name: 'cadastrar_prospect',
    description: 'Cadastra um potencial cliente (prospect) no sistema da academia. Use quando o cliente demonstrar interesse e fornecer dados básicos.',
    input_schema: {
      type: 'object',
      properties: {
        nome: {
          type: 'string',
          description: 'Nome completo do prospect',
        },
        telefone: {
          type: 'string',
          description: 'Telefone do prospect (já temos do WhatsApp)',
        },
        email: {
          type: 'string',
          description: 'E-mail do prospect (se fornecido)',
        },
        interesse: {
          type: 'string',
          description: 'Modalidade de interesse principal',
        },
      },
      required: ['nome', 'telefone'],
    },
  },
  {
    name: 'agendar_aula_experimental',
    description: 'Agenda uma aula experimental gratuita para o prospect. Use quando o cliente aceitar fazer uma aula experimental.',
    input_schema: {
      type: 'object',
      properties: {
        nome: {
          type: 'string',
          description: 'Nome do prospect',
        },
        telefone: {
          type: 'string',
          description: 'Telefone do prospect',
        },
        modalidade: {
          type: 'string',
          description: 'Modalidade desejada',
        },
        data_preferencia: {
          type: 'string',
          description: 'Data de preferência no formato YYYY-MM-DD',
        },
      },
      required: ['nome', 'telefone', 'modalidade'],
    },
  },
  {
    name: 'emitir_voucher',
    description: 'Gera um voucher de desconto ou cortesia para o prospect. Use com moderação e apenas quando for estrategicamente relevante para fechar uma venda.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          description: 'Tipo do voucher: "desconto_percentual", "desconto_fixo", "aula_gratis"',
          enum: ['desconto_percentual', 'desconto_fixo', 'aula_gratis'],
        },
        valor: {
          type: 'number',
          description: 'Valor do desconto (percentual ou fixo em reais)',
        },
        validade_dias: {
          type: 'number',
          description: 'Dias de validade do voucher',
        },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'transferir_para_humano',
    description: 'Transfere a conversa para um consultor humano e pausa o bot. Use quando: financeiro de aluno JÁ MATRICULADO (pagamento pendente, cobrança, estorno), problema de CONTA no app FITI (não consegue entrar, reserva sumiu), afastamento/cancelamento, reclamação, ou pedido explícito de falar com uma pessoa. NÃO use para: objeção de preço ou pedido de desconto em venda nova, nem "como funciona o agendamento?" — essas você responde. Se faltar um dado na base, confira antes se outra parte da base responde; faltando mesmo, responda o resto e transfira só o ponto que falta.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Por que está transferindo. Vai para o consultor no painel — o cliente não lê isto.',
        },
        mensagem: {
          type: 'string',
          description: 'A última mensagem que o cliente lê antes de o bot pausar. Escreva no tom da conversa e adequada ao motivo: quem relata um pagamento não debitado não pode ler "vou confirmar essa informação". Curta, formatada para WhatsApp.',
        },
      },
      required: ['motivo', 'mensagem'],
    },
  },
];

/** Tools efetivamente oferecidas ao Claude (as pausadas ficam de fora). */
export const toolDeclarations = allToolDeclarations.filter(t => !PAUSED_TOOLS.has(t.name));

// ──────────────────────────────────────────────
// Handlers das tools
// ──────────────────────────────────────────────

const handlers = {
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
    // Retorna sinal para o agente pausar o bot.
    //
    // A despedida é escrita pelo modelo, não fixa aqui: o handoff atende
    // situações muito diferentes (preço ausente, pagamento, erro no app,
    // reclamação) e uma frase única soa errada em quase todas elas.
    // O texto abaixo é só rede de segurança se o modelo omitir a mensagem.
    return {
      success: true,
      action: 'handoff',
      motivo: args.motivo,
      mensagem: args.mensagem
        || 'Vou chamar um consultor para te ajudar com isso 😊 Já te retorno por aqui!',
    };
  },
};

/**
 * Executa uma tool pelo nome.
 * @param {string} name - Nome da ferramenta
 * @param {object} args - Argumentos passados pelo modelo
 * @returns {Promise<object>} Resultado da execução
 */
export async function executeTool(name, args) {
  // Barreira extra: mesmo não sendo declarada, o modelo pode alucinar a
  // chamada de uma tool pausada. Nunca executar nesse caso.
  if (PAUSED_TOOLS.has(name)) {
    logger.warn(`[ai-tools] Tool pausada foi chamada e bloqueada: ${name}`);
    return {
      success: false,
      mensagem: 'Essa ação não está disponível. Ofereça encaminhar a pessoa a um consultor.',
    };
  }

  const handler = handlers[name];
  if (!handler) {
    logger.warn(`[ai-tools] Tool desconhecida: ${name}`);
    return { success: false, mensagem: `Ferramenta "${name}" não encontrada.` };
  }

  logger.info(`[ai-tools] Executando tool: ${name}`, JSON.stringify(args));
  return handler(args);
}
