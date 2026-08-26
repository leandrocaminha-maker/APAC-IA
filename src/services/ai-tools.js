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
import { MODULOS } from './knowledge.js';

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
  {
    name: 'carregar_base',
    description:
      'Carrega no seu contexto um módulo da base de conhecimento que não está carregado agora. ' +
      'O cabeçalho da sua BASE DE CONHECIMENTO diz quais módulos estão e quais NÃO estão. ' +
      'Use assim que perceber que o assunto do cliente é de um módulo ausente — ANTES de responder, ' +
      'e antes de cogitar `transferir_para_humano`. ' +
      'Módulo `infantil`: turmas, idades, níveis e objeções da escola de natação infantil e de bebês. ' +
      'Módulo `infantil-tecnico`: a metodologia infantil por dentro — as fases do programa, o conteúdo ' +
      'de cada nível, as metas objetivas de promoção e o glossário. Peça quando o responsável quiser ' +
      'entender COMO o programa funciona ("por que ele ainda não nada crawl?", "como vocês decidem que ' +
      'ele mudou de nível?", "o que é palmateio?"), não para dizer em que nível a criança começa. ' +
      'Módulo `adulto`: qualificação do público 13+ e regras de uso do plano adulto — agendamento pelo ' +
      'FITI, avaliação física, suspensão, devolução em 21 dias. Peça quando uma conversa que começou ' +
      'sobre criança passar a tratar de plano para um adulto. ' +
      'Módulo `matriculado`: contrato, férias, atestado, afastamento, cancelamento e app FITI. ' +
      'Não custa nada ao cliente e não aparece para ele: se estiver em dúvida, carregue. ' +
      'Nunca responda de memória sobre um assunto cujo módulo está ausente.',
    input_schema: {
      type: 'object',
      properties: {
        modulo: {
          type: 'string',
          description: 'Qual módulo carregar.',
          enum: ['infantil', 'infantil-tecnico', 'adulto', 'matriculado'],
        },
      },
      required: ['modulo'],
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
   * Puxa um módulo ausente da base de conhecimento.
   *
   * Não devolve o TEXTO do módulo de propósito. Um `tool_result` com 9.647
   * tokens de natação infantil dentro entraria em `messages`, que fica fora
   * do breakpoint de cache — a preço cheio, e reenviado em toda chamada
   * seguinte da conversa. Sairia mais caro do que o problema que resolve.
   *
   * Em vez disso devolve uma ordem para `ai-agent.js`, que remonta o
   * `system` com o módulo dentro. Ali ele é cacheado como qualquer outra
   * variante de prefixo, e é lido a ~10% do preço nas chamadas seguintes.
   */
  async carregar_base(args, contexto) {
    const modulo = String(args.modulo || '').trim();

    // `nucleo` vai sempre; pedi-lo é sinal de que o modelo não leu o
    // cabeçalho, e recarregá-lo não faria nada. `adulto` saiu desta lista em
    // 26/08/2026: ele deixou de ser incondicional, então agora é pedível.
    if (!MODULOS[modulo] || modulo === 'nucleo') {
      return {
        success: false,
        mensagem: `Não existe módulo "${modulo}" para carregar. Os que se pode pedir são ` +
          '`infantil`, `infantil-tecnico`, `adulto` e `matriculado`. Se o que você procura ' +
          'não é nenhum deles, o dado não está na base — nesse caso vale ' +
          '`transferir_para_humano`.',
      };
    }

    if ((contexto?.modulosCarregados || []).includes(modulo)) {
      return {
        success: true,
        ja_carregado: true,
        mensagem: `O módulo "${modulo}" JÁ está na sua base de conhecimento. ` +
          'Releia a seção correspondente e responda ao cliente — não chame esta ferramenta de novo.',
      };
    }

    return {
      success: true,
      action: 'carregar_modulo',
      modulo,
      mensagem: `Módulo "${modulo}" carregado. O conteúdo já está na sua BASE DE CONHECIMENTO. ` +
        'Leia-o e responda ao cliente a partir dele.',
    };
  },

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
      // 1. Existe cadastro de aluno? Se existir, ele está ATIVO?
      //
      // A distinção é o ponto todo: o EVO não devolve `member` para
      // `prospect` nunca — quem se matriculou em 2018 e parou em 2021
      // continua "aluno" para sempre. A academia não opera assim, e a
      // própria API concorda na prática: tentar matricular um inativo numa
      // aula devolve "Agendamento indisponível pelo motivo: Inactive
      // member". Quem parou há mais de `mesesReativacao` volta a ser lead.
      if (telefone) {
        const { cellphone } = evoClient.separarDdi(telefone);
        const membros = await evoClient.buscarMembros({ phone: cellphone, take: 5 });

        if (membros.length) {
          const m = membros[0];
          const situacao = await evoClient.situacaoDoMembro(m.idMember);
          const perfil = situacao.membro || m;
          const dados = {
            nome: [perfil.firstName, perfil.lastName].filter(Boolean).join(' '),
            email: perfil.email || null,
            nascimento: perfil.birthDate ? String(perfil.birthDate).slice(0, 10) : null,
            celular: cellphone,
          };

          if (situacao.ativo || !situacao.reativavel) {
            return {
              success: true,
              encontrado: 'aluno',
              idMember: m.idMember,
              ativo: situacao.ativo,
              mesesInativo: situacao.mesesInativo,
              dados,
              mensagem: situacao.ativo
                ? 'Esta pessoa JÁ É ALUNA ativa. Aula experimental é para quem ainda não é aluno. ' +
                  'Confirme o que ela quer de fato — experimentar outra modalidade é assunto de consultor.'
                : `Parou há apenas ${situacao.mesesInativo} mês(es). Ainda é caso de retenção, não de lead novo — ` +
                  'trate como aluno e transfira para o consultor.',
            };
          }

          // Ex-aluno que voltou: é lead de novo.
          //
          // Guardamos o vínculo com o cadastro antigo no lead para o
          // consultor ver os dois lados no painel — e para uma venda futura
          // sair no cadastro de aluno que já existe, em vez de criar outro.
          try {
            const { lead } = await leadDaConversa(contexto);
            // Guardamos os dados do cadastro antigo no lead — não só o
            // vínculo. É o que permite abrir a oportunidade mais tarde, na
            // hora do agendamento, sem pedir nada de novo à pessoa.
            await supabase
              .from('crm_leads')
              .update({
                evo_id_member: m.idMember,
                full_name: dados.nome || lead.full_name,
                email: lead.email || dados.email,
                birth_date: lead.birth_date || dados.nascimento,
              })
              .eq('id', lead.id);
          } catch (err) {
            logger.warn(`[ai-tools] Não consegui vincular o ex-aluno ao lead: ${err.message}`);
          }

          return {
            success: true,
            encontrado: 'ex_aluno',
            idMember: m.idMember,
            mesesInativo: situacao.mesesInativo,
            fimUltimoContrato: situacao.fimUltimoContrato,
            dados,
            mensagem:
              `Foi aluna, mas está sem contrato há ${situacao.mesesInativo ?? 'muitos'} meses` +
              `${situacao.fimUltimoContrato ? ` (último até ${situacao.fimUltimoContrato})` : ''}. ` +
              'Pelas regras da academia ela VOLTOU À CONDIÇÃO DE LEAD e PODE fazer aula experimental. ' +
              'Trate como quem está voltando, não como desconhecida: confirme os dados acima, ' +
              'não peça tudo de novo, e siga com `cadastrar_prospect` e depois o agendamento.',
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

      // ⚠️ Ex-aluno NÃO vira oportunidade aqui.
      //
      // Ele já tem cadastro de cliente no EVO. Abrir uma oportunidade em
      // paralelo só se justifica quando ela é necessária — e é necessária
      // por uma razão só: o endpoint de aula experimental não aceita
      // `idMember`. Se a conversa não chegar à experimental, a pessoa
      // continua sendo o cliente que já era, e o fechamento sai no cadastro
      // dela em vez de num registro novo.
      //
      // Por isso a criação foi movida para dentro do agendamento, que é
      // exatamente o momento em que ela deixa de ser opcional.
      if (lead.evo_id_member && !lead.evo_id_prospect) {
        await supabase
          .from('crm_leads')
          .update({
            full_name: nome,
            birth_date: args.data_nascimento || lead.birth_date,
            email: args.email || lead.email,
            interest: args.interesse || lead.interest,
          })
          .eq('id', lead.id);

        return {
          success: true,
          idMember: lead.evo_id_member,
          semCadastroNovo: true,
          mensagem: 'Ela já tem cadastro de cliente e os dados foram confirmados — não criei cadastro novo. ' +
            'Se ela fechar a aula experimental, a oportunidade é aberta no agendamento. ' +
            'Se não quiser, siga a conversa normalmente: a venda sai no cadastro que ela já tem.',
        };
      }

      // Ex-aluno reativado: a nota liga o cadastro novo ao antigo.
      //
      // O EVO não tem como vincular prospect a member, então sem isto o
      // consultor abriria uma oportunidade que parece de alguém que nunca
      // pisou na academia — quando na verdade é um retorno, e o histórico
      // muda a conversa de venda.
      const observacoes = lead.evo_id_member
        ? `Cadastrado pela Leia no WhatsApp. RETORNO de ex-aluno — cadastro anterior: member #${lead.evo_id_member}. ` +
          `Interesse: ${args.interesse || 'não informado'}.`
        : `Cadastrado pela Leia no WhatsApp. Interesse: ${args.interesse || 'não informado'}.`;

      const r = await evoSync.cadastrarProspect(lead, {
        dados: {
          nomeCompleto: nome,
          dataNascimento: args.data_nascimento || null,
          email: args.email || null,
          telefone: args.telefone || contexto?.phone,
          observacoes,
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

      if (r.jaEstava) {
        return {
          success: true,
          jaEstava: true,
          mensagem: `Esta pessoa JÁ TEM aula marcada nesse dia — ${r.mensagem || dataHora}. ` +
            'NÃO agende outro horário e NÃO ofereça alternativa: está tudo certo. ' +
            'Apenas confirme com ela o que já está marcado.',
        };
      }

      return {
        success: true,
        dryRun: r.dryRun,
        mensagem: `Aula de ${args.atividade} agendada para ${dataHora}. ` +
          'Confirme com a pessoa, diga o que levar e lembre de chegar 15 minutos antes.',
      };
    } catch (err) {
      logger.error('[ai-tools] agendar_aula_experimental:', err.message);

      // Horário fora da grade é recusado antes de qualquer escrita, com a
      // mensagem já pronta para a conversa. Vale repassá-la como está — é
      // mais útil do que o texto genérico.
      if (/^Não há /.test(err.message)) {
        return {
          success: false,
          mensagem: `${err.message} Ofereça à pessoa os horários que realmente existem na grade para essa atividade.`,
        };
      }

      // O resto (turma lotada, recusa do EVO) a pessoa não pode ler como
      // "erro 400".
      return {
        success: false,
        mensagem: 'O sistema não aceitou esse agendamento — pode ser turma cheia. ' +
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
