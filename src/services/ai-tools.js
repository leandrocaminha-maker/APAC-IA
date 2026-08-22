/**
 * src/services/ai-tools.js
 * Ferramentas (tool use) disponíveis para a Leia.
 *
 * NOTA — consultas de informação ao EVO continuam desativadas:
 * planos, valores, modalidades e grade horária vêm dos arquivos em
 * src/prompts/knowledge/, carregados no contexto a cada resposta. Mais
 * preciso e com o texto sob nosso controle.
 *
 * NOTA — agendamento de aula experimental, ligado em 22/08/2026:
 * a Leia passou a conduzir o agendamento inteiro. As três tools do fluxo
 * (`buscar_cadastro`, `cadastrar_prospect`, `agendar_aula_experimental`)
 * escrevem no EVO **através de `evo-sync.js`**, nunca direto no client.
 *
 * Isso não é detalhe de organização: `evo-sync` é quem move a etapa do
 * lead, grava o autor no razão do funil e guarda a resposta crua do EVO.
 * Uma tool que chamasse `evo-client` direto criaria o prospect no EVO e
 * deixaria o funil sem saber — o consultor abriria o painel e veria um
 * lead "não cadastrado" que já existe lá.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { evoClient } from './evo-client.js';
import { evoSync } from './evo-sync.js';
import { funil } from './funil.js';

// ──────────────────────────────────────────────
// Tools pausadas
//
// Não são declaradas ao Claude nem executáveis. Para reativar uma delas,
// remova o nome desta lista.
//
// - emitir_voucher ... gera código que não é persistido em lugar nenhum;
//                      o cliente receberia um voucher irresgatável.
//                      Precisa de tabela de vouchers antes.
// ──────────────────────────────────────────────

const PAUSED_TOOLS = new Set([
  'emitir_voucher',
]);

// ──────────────────────────────────────────────
// Declarações
// ──────────────────────────────────────────────

const allToolDeclarations = [
  {
    name: 'buscar_cadastro',
    description:
      'Procura a pessoa no sistema da academia (EVO) antes de cadastrar qualquer coisa. ' +
      'SEMPRE use isto antes de `cadastrar_prospect`. Sem telefone informado, procura pelo número da conversa atual. ' +
      'Responde se encontrou um ALUNO (member, já matriculado), uma OPORTUNIDADE (prospect, já cadastrado antes) ou NADA. ' +
      'Quando encontra, devolve os dados do cadastro para você conferir com a pessoa antes de seguir.',
    input_schema: {
      type: 'object',
      properties: {
        telefone: {
          type: 'string',
          description: 'Celular a procurar. Deixe vazio para usar o número desta conversa.',
        },
        nome: {
          type: 'string',
          description: 'Nome completo, se a pessoa já informou. Ajuda quando o telefone não acha nada.',
        },
        email: { type: 'string', description: 'E-mail, se informado.' },
      },
      required: [],
    },
  },
  {
    name: 'cadastrar_prospect',
    description:
      'Cadastra a pessoa como oportunidade no sistema da academia. ' +
      'Use SÓ depois de `buscar_cadastro` não ter encontrado ninguém, e SÓ com nome completo, data de nascimento e e-mail já coletados. ' +
      'Se `buscar_cadastro` achou alguém, não chame isto — o cadastro já existe.',
    input_schema: {
      type: 'object',
      properties: {
        nome_completo: {
          type: 'string',
          description: 'Nome e sobrenome. O EVO recusa cadastro sem sobrenome.',
        },
        data_nascimento: {
          type: 'string',
          description: 'Data de nascimento no formato AAAA-MM-DD.',
        },
        email: { type: 'string', description: 'E-mail da pessoa.' },
        telefone: {
          type: 'string',
          description: 'Celular com DDD. Deixe vazio para usar o número desta conversa.',
        },
        interesse: {
          type: 'string',
          description: 'Modalidade de interesse, como a pessoa falou (ex.: "natação adulto").',
        },
      },
      required: ['nome_completo', 'data_nascimento', 'email'],
    },
  },
  {
    name: 'agendar_aula_experimental',
    description:
      'Agenda a aula experimental na agenda da academia e registra o serviço de aula experimental. ' +
      'Use SÓ depois de a pessoa ter cadastro (encontrado por `buscar_cadastro` ou criado por `cadastrar_prospect`) ' +
      'e de ter escolhido atividade e horário existentes na GRADE HORÁRIA da base de conhecimento. ' +
      'Nunca invente horário: se o que a pessoa quer não está na grade, ofereça os que estão.',
    input_schema: {
      type: 'object',
      properties: {
        data_hora: {
          type: 'string',
          description: 'Data e hora da aula no formato AAAA-MM-DD HH:mm. Use a data de hoje que está no seu contexto para converter "amanhã", "quinta" etc.',
        },
        atividade: {
          type: 'string',
          description: 'Nome da atividade como aparece na grade horária (ex.: "NATAÇÃO ADULTO", "MUSCULAÇÃO").',
        },
      },
      required: ['data_hora', 'atividade'],
    },
  },
  {
    name: 'emitir_voucher',
    description: 'Gera um voucher de desconto ou cortesia para o prospect.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          description: 'Tipo do voucher',
          enum: ['desconto_percentual', 'desconto_fixo', 'aula_gratis'],
        },
        valor: { type: 'number', description: 'Valor do desconto' },
        validade_dias: { type: 'number', description: 'Dias de validade' },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'transferir_para_humano',
    description: 'Transfere a conversa para um consultor humano e pausa o bot. Use quando: financeiro de aluno JÁ MATRICULADO (pagamento pendente, cobrança, estorno), problema de CONTA no app FITI (não consegue entrar, reserva sumiu), afastamento/cancelamento, reclamação, ou pedido explícito de falar com uma pessoa. NÃO use para: objeção de preço ou pedido de desconto em venda nova, nem "como funciona o agendamento?" — essas você responde. Também NÃO use para agendar aula experimental de quem ainda não é aluno: isso você mesma faz, com as tools de cadastro e agendamento. Se faltar um dado na base, confira antes se outra parte da base responde; faltando mesmo, responda o resto e transfira só o ponto que falta.',
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
// Contexto da conversa
//
// As tools de escrita precisam saber DE QUEM é a conversa. Sem isso não há
// como ligar o prospect criado no EVO ao lead do funil, e o painel ficaria
// mostrando "não cadastrado" para quem já foi cadastrado.
// ──────────────────────────────────────────────

/**
 * Conversa de teste? (`/teste` e o simulador do painel).
 *
 * Estes contatos têm telefone sintético `teste-<uuid>`. **Nunca** podem
 * escrever no EVO: a rodada de testes do time criaria prospects de mentira
 * no sistema de produção da academia, e não há como apagá-los depois — o
 * EVO não tem DELETE de prospect.
 */
function ehContatoDeTeste(contexto) {
  const phone = String(contexto?.phone || '');
  return phone.startsWith('teste') || (contexto?.tags || []).includes('teste-web');
}

/** Carrega o contato e o lead aberto correspondente. */
async function leadDaConversa(contexto) {
  if (!contexto?.contactId) {
    throw new Error('sem contexto de contato — a tool foi chamada fora de uma conversa');
  }

  const { data: contato } = await supabase
    .from('wa_contacts')
    .select('*')
    .eq('id', contexto.contactId)
    .maybeSingle();

  if (!contato) throw new Error('contato não encontrado');

  const lead = await funil.garantirLeadDoContato(contato);
  if (!lead) throw new Error('não foi possível abrir o lead no funil');

  return { contato, lead };
}

/** Resposta padrão quando a tool roda numa conversa de teste. */
function respostaSimulada(acao, detalhe = {}) {
  logger.info(`[ai-tools] SIMULADO (conversa de teste): ${acao}`);
  return {
    success: true,
    simulado: true,
    aviso: 'Esta é uma conversa de teste: nada foi escrito no sistema da academia. ' +
      'Siga a conversa normalmente, como se tivesse dado certo.',
    ...detalhe,
  };
}

/** Data/hora 'AAAA-MM-DD HH:mm' → validação amigável. */
function validarDataHora(valor) {
  const texto = String(valor || '').trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(texto)) {
    return { erro: 'formato inválido, use AAAA-MM-DD HH:mm' };
  }
  const quando = new Date(texto.replace(' ', 'T') + ':00-03:00');
  if (Number.isNaN(quando.getTime())) return { erro: 'data inválida' };
  if (quando.getTime() < Date.now() - 60 * 60 * 1000) {
    return { erro: 'a data está no passado' };
  }
  return { texto, quando };
}

// ──────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────

const handlers = {
  /**
   * Procura a pessoa no EVO antes de cadastrar.
   *
   * Procura em DUAS bases, e a ordem importa: quem já é aluno (member) não
   * pode receber o fluxo de aula experimental, que no EVO é exclusivo de
   * oportunidade. Descobrir isso depois de coletar todos os dados seria
   * desperdiçar a paciência da pessoa.
   */
  async buscar_cadastro(args, contexto) {
    const telefone = args.telefone || contexto?.phone;

    if (ehContatoDeTeste(contexto) && !args.telefone) {
      return respostaSimulada('buscar_cadastro', {
        encontrado: 'nada',
        mensagem: 'Nenhum cadastro encontrado (simulado). Siga pedindo os dados.',
      });
    }

    try {
      // 1. Já é aluno?
      if (telefone) {
        const { cellphone } = evoClient.separarDdi(telefone);
        const membros = await evoClient.buscarMembros({ phone: cellphone, take: 5 });
        if (membros.length) {
          const m = membros[0];
          return {
            success: true,
            encontrado: 'aluno',
            idMember: m.idMember,
            dados: {
              nome: [m.firstName, m.lastName].filter(Boolean).join(' '),
              email: m.email || null,
              nascimento: m.birthDate ? String(m.birthDate).slice(0, 10) : null,
              celular: m.cellphone || null,
            },
            mensagem: 'Esta pessoa JÁ É ALUNA da academia. Aula experimental é para quem ainda não é aluno. ' +
              'Confirme com ela o que ela quer de fato — experimentar outra modalidade é assunto de consultor.',
          };
        }
      }

      // 2. Já é oportunidade?
      let prospect = telefone ? await evoClient.buscarProspectPorTelefone(telefone) : null;

      if (!prospect && args.email) {
        const [p] = await evoClient.buscarProspects({ email: args.email, take: 5 });
        prospect = p || null;
      }
      if (!prospect && args.nome) {
        const [p] = await evoClient.buscarProspects({ name: args.nome, take: 5 });
        prospect = p || null;
      }

      if (prospect) {
        // Vincula ao funil já, para o painel não mostrar "não cadastrado".
        try {
          const { lead } = await leadDaConversa(contexto);
          if (!lead.evo_id_prospect) {
            await evoSync.cadastrarProspect(lead, {});
          }
        } catch (err) {
          logger.warn(`[ai-tools] Não consegui vincular o prospect ao lead: ${err.message}`);
        }

        return {
          success: true,
          encontrado: 'oportunidade',
          idProspect: prospect.idProspect,
          dados: {
            nome: [prospect.firstName, prospect.lastName].filter(Boolean).join(' '),
            email: prospect.email || null,
            nascimento: prospect.birthDate ? String(prospect.birthDate).slice(0, 10) : null,
            celular: prospect.cellphone || null,
          },
          mensagem: 'Já existe cadastro. NÃO cadastre de novo. Confirme os dados acima com a pessoa ' +
            '(o que estiver em branco, peça) e siga para o agendamento.',
        };
      }

      return {
        success: true,
        encontrado: 'nada',
        mensagem: 'Nenhum cadastro encontrado. Colete nome completo, data de nascimento e e-mail, ' +
          'depois use `cadastrar_prospect`.',
      };
    } catch (err) {
      logger.error('[ai-tools] buscar_cadastro:', err.message);
      return {
        success: false,
        mensagem: 'Não consegui consultar o sistema agora. Continue a conversa normalmente e, ' +
          'se a pessoa quiser agendar, transfira para um consultor.',
      };
    }
  },

  /** Cria a oportunidade no EVO e vincula ao lead do funil. */
  async cadastrar_prospect(args, contexto) {
    const nome = String(args.nome_completo || '').trim();
    if (!nome.includes(' ')) {
      return {
        success: false,
        mensagem: 'O sistema precisa de nome E sobrenome. Peça o nome completo antes de tentar de novo.',
      };
    }

    if (ehContatoDeTeste(contexto)) {
      return respostaSimulada('cadastrar_prospect', {
        idProspect: -1,
        mensagem: 'Cadastro simulado. Siga para o agendamento normalmente.',
      });
    }

    try {
      const { lead } = await leadDaConversa(contexto);

      const r = await evoSync.cadastrarProspect(lead, {
        dados: {
          nomeCompleto: nome,
          dataNascimento: args.data_nascimento || null,
          email: args.email || null,
          telefone: args.telefone || contexto?.phone,
          observacoes: `Cadastrado pela Leia no WhatsApp. Interesse: ${args.interesse || 'não informado'}.`,
        },
      });

      // O interesse em texto ajuda o consultor no painel.
      if (args.interesse) {
        await supabase.from('crm_leads').update({ interest: args.interesse }).eq('id', lead.id);
      }

      return {
        success: true,
        idProspect: r.idProspect,
        mensagem: r.criado
          ? 'Cadastro criado. Agora pode agendar a aula experimental.'
          : 'Esta pessoa já tinha cadastro e ele foi vinculado. Pode agendar.',
      };
    } catch (err) {
      logger.error('[ai-tools] cadastrar_prospect:', err.message);
      return {
        success: false,
        mensagem: 'Não consegui cadastrar agora. Diga que vai confirmar o agendamento com um consultor ' +
          'e use `transferir_para_humano` com os dados que já coletou.',
      };
    }
  },

  /**
   * Agenda a aula na agenda do EVO.
   *
   * O endpoint do EVO faz as duas coisas numa chamada só: **vende o serviço
   * de aula experimental e matricula** a pessoa na sessão. Não é preciso um
   * `POST /api/v2/sales` separado — e fazer os dois criaria a venda em
   * duplicidade.
   */
  async agendar_aula_experimental(args, contexto) {
    const { texto: dataHora, erro } = validarDataHora(args.data_hora);
    if (erro) {
      return {
        success: false,
        mensagem: `A data/hora não serve (${erro}). Confirme o dia e o horário com a pessoa e tente de novo, ` +
          'no formato AAAA-MM-DD HH:mm.',
      };
    }

    if (ehContatoDeTeste(contexto)) {
      return respostaSimulada('agendar_aula_experimental', {
        mensagem: `Agendamento simulado para ${dataHora}. Confirme com a pessoa como se tivesse dado certo.`,
      });
    }

    try {
      const { lead } = await leadDaConversa(contexto);

      if (!lead.evo_id_prospect) {
        return {
          success: false,
          mensagem: 'Esta pessoa ainda não tem cadastro. Use `buscar_cadastro` e, se não achar, ' +
            '`cadastrar_prospect` antes de agendar.',
        };
      }

      const r = await evoSync.agendarExperimental(lead, {
        dataHora,
        atividade: args.atividade,
      });

      return {
        success: true,
        dryRun: r.dryRun,
        mensagem: `Aula de ${args.atividade} agendada para ${dataHora}. ` +
          'Confirme com a pessoa, diga o que levar e lembre de chegar 15 minutos antes.',
      };
    } catch (err) {
      logger.error('[ai-tools] agendar_aula_experimental:', err.message);

      // O EVO recusa horário que não existe na grade, sessão lotada e
      // atividade com nome que não bate. A pessoa não pode ler "erro 400".
      return {
        success: false,
        mensagem: 'O sistema não aceitou esse horário. Pode ser turma cheia ou horário que não existe na grade. ' +
          'Ofereça outro horário da grade; se insistir em não dar certo, use `transferir_para_humano` ' +
          `com o horário desejado no motivo. Detalhe técnico: ${err.message.slice(0, 160)}`,
      };
    }
  },

  async emitir_voucher(args) {
    const code = `AP${Date.now().toString(36).toUpperCase()}`;
    const validade = new Date();
    validade.setDate(validade.getDate() + (args.validade_dias || 7));
    return {
      success: true,
      voucher: { codigo: code, tipo: args.tipo, valor: args.valor || null,
        validade: validade.toISOString().slice(0, 10) },
      mensagem: `Voucher ${code} gerado com sucesso!`,
    };
  },

  async transferir_para_humano(args) {
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
 *
 * @param {string} name
 * @param {object} args     - argumentos do modelo
 * @param {object} contexto - { contactId, conversationId, phone, tags }
 */
export async function executeTool(name, args, contexto = {}) {
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

  logger.info(`[ai-tools] Executando: ${name}`, JSON.stringify(args));

  try {
    return await handler(args, contexto);
  } catch (err) {
    // Uma tool que estoura não pode derrubar o turno: o cliente ficaria sem
    // resposta nenhuma. Devolvemos o erro como resultado para o modelo
    // contornar na conversa.
    logger.error(`[ai-tools] ${name} lançou exceção:`, err.message);
    return {
      success: false,
      mensagem: 'Deu um problema técnico nessa ação. Siga a conversa e, se for necessário concluir, ' +
        'use `transferir_para_humano`.',
    };
  }
}
