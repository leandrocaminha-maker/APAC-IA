/**
 * src/services/segmentos.js
 * Coortes de campanha, montadas a partir da base do EVO.
 *
 * ## Por que não sai do webhook
 *
 * Os 6 eventos assinados em `EVENTOS_WEBHOOK` são todos de conversão —
 * NewSale, RecurrentSale, CreateMember, CreateMembership, ActivityEnroll,
 * TransferProspect. Eles dizem "fulano comprou", não "fulano é alvo". Para
 * campanha o que interessa é o oposto: quem está num certo ESTADO hoje, o
 * que quase sempre significa quem NÃO fez alguma coisa.
 *
 * Isso não se descobre esperando evento; se descobre puxando a base. O
 * webhook continua útil para manter o estado fresco e para as campanhas de
 * gatilho — mas quem monta coorte é este arquivo.
 *
 * ## Por que materializa
 *
 * `situacaoDoMembro()` faz DUAS chamadas ao EVO por pessoa (perfil +
 * contratos). Numa base de milhares isso é dezenas de milhares de
 * requisições — inviável ao vivo, a cada ciclo do worker. Então a coorte é
 * montada uma vez, gravada em `crm_campanha_alvos`, e a campanha lê do
 * banco daí em diante.
 *
 * O efeito colateral é intencional: a coorte é um retrato datado. Quem
 * fechou plano depois da montagem ainda está na lista — por isso
 * `campanhas.js` reconfere a supressão e a resposta antes de cada disparo,
 * e por isso o `contexto` guarda a data em que o retrato foi tirado.
 */
import { evoClient } from './evo-client.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

// O EVO limita `take` a 50 em /prospects e é prudente com o mesmo teto em
// /members. Paginação é obrigatória, não otimização.
const PAGINA = 50;

// Teto de segurança na varredura. Uma campanha que quisesse mais gente que
// isto de uma vez é uma campanha que precisa de conversa antes de código.
const MAX_VARREDURA = 5000;

// Teto de consultas DETALHADAS (as caras: 2 requisições cada) por rodada.
// A 25 req/min, 200 detalhes já são ~16 minutos de varredura.
const MAX_DETALHES = 200;

/**
 * Freio de requisições ao EVO.
 *
 * A API responde 429 com "The request limit of 40 requests per minute has
 * been reached" — descoberto batendo nele em 25/08/2026, ao montar o
 * primeiro segmento.
 *
 * O teto aqui é 25/min, não 40, porque a cota é da CONTA e não deste
 * processo: o `evo-sync-worker` varre prospects a cada 15 minutos e as
 * tools do agente consultam o EVO no meio de uma conversa com cliente. Uma
 * varredura de campanha que consumisse a cota inteira faria o cadastro de
 * um prospect real falhar no meio do atendimento — trocar venda por
 * relatório é um péssimo negócio.
 */
const REQ_POR_MINUTO = 25;
const INTERVALO_MS = Math.ceil(60_000 / REQ_POR_MINUTO);
let ultimaChamada = 0;

/** Espera o tempo necessário para respeitar o teto antes de seguir. */
async function respirar() {
  const desde = Date.now() - ultimaChamada;
  if (desde < INTERVALO_MS) {
    await new Promise(r => setTimeout(r, INTERVALO_MS - desde));
  }
  ultimaChamada = Date.now();
}

/**
 * Telefone utilizável para WhatsApp, a partir do que o EVO devolve.
 *
 * **O celular não é um campo.** O EVO devolve `contacts[]`, uma lista em que
 * cada item tem `contactType` ('Cellphone', 'Telephone', 'E-mail') e o valor
 * em `description`, já formatado — "(11)999999999". A primeira versão disto
 * lia `pessoa.cellphone`, que simplesmente não existe: o efeito seria uma
 * coorte sempre vazia, sem erro nenhum no log.
 *
 * Devolve null quando não dá para usar, e a pessoa fica fora da coorte em
 * silêncio. Fixo não recebe WhatsApp, e número inválido em volume é sinal
 * de lista comprada — que é o que faz o WhatsApp bloquear o remetente.
 */
function telefoneUtil(pessoa) {
  const contatos = Array.isArray(pessoa?.contacts) ? pessoa.contacts : [];

  const candidatos = contatos
    .filter(c => /cell/i.test(c?.contactType || ''))
    .map(c => String(c?.description || ''));

  // Alguns cadastros antigos guardam o celular sem tipo; como último
  // recurso, qualquer contato que se pareça com celular serve.
  if (!candidatos.length) {
    candidatos.push(...contatos.map(c => String(c?.description || '')));
  }

  for (const bruto of candidatos) {
    const digitos = String(bruto).replace(/\D/g, '');
    const semDdi = digitos.startsWith('55') && digitos.length > 11
      ? digitos.slice(2)
      : digitos;

    // Celular brasileiro: DDD (2) + 9 dígitos. Fixo (10) não serve.
    if (semDdi.length !== 11) continue;
    if (semDdi.startsWith('0')) continue;
    // O nono dígito de celular é sempre 9.
    if (semDdi[2] !== '9') continue;
    return `55${semDdi}`;
  }

  return null;
}

/**
 * A listagem diz que a pessoa está ativa?
 *
 * **Não use `membershipStatus` aqui.** Na listagem ele vem como string
 * vazia — quem carrega o dado é `status` ('Active' / 'Inactive'). O
 * `membershipStatus` só é preenchido em `buscarMembroPorId`, que é uma
 * chamada por pessoa e a coisa exata que este pré-filtro existe para
 * evitar.
 */
function ativoNaListagem(membro) {
  return String(membro?.status || '').toLowerCase() === 'active';
}

/** Nome de tratamento: só o primeiro, que é como se fala no WhatsApp. */
function primeiroNome(nomeCompleto) {
  const limpo = String(nomeCompleto || '').trim();
  if (!limpo) return null;
  return limpo.split(/\s+/)[0];
}

// ──────────────────────────────────────────────
// Segmentos
//
// Cada um devolve [{ phone, nome, evo_id_member, evo_id_prospect, contexto }].
// O `contexto` é o que o gerador de texto usa para falar do caso da pessoa
// em vez de repetir o mesmo parágrafo — e é também o que, relido meses
// depois, explica por que aquela mensagem foi enviada.
// ──────────────────────────────────────────────

/**
 * Ex-aluno que já pode voltar a receber oferta de lead.
 *
 * O EVO não tem caminho de volta de `member` para `prospect`: quem se
 * matriculou em 2018 e parou em 2021 continua "aluno" para sempre. Quem
 * resolve isso é `situacaoDoMembro()`, que junta o status do perfil com a
 * data de fim do último contrato e responde o que de fato importa.
 *
 * @param {object} [args]
 * @param {number} [args.mesesMin] - Inativo há pelo menos isto. Default: o
 *   mesmo `EVO_MESES_REATIVACAO` que o funil usa, para as duas partes do
 *   sistema não discordarem sobre quem é lead.
 * @param {number} [args.mesesMax] - Teto de inatividade. Quem parou há 8
 *   anos não é reativação, é lista fria — e é o tipo de contato que gera
 *   denúncia.
 * @param {number} [args.limite]
 */
async function exAlunoReativavel({
  mesesMin = config.evo.mesesReativacao,
  mesesMax = 36,
  limite = 500,
} = {}) {
  const achados = [];
  let skip = 0;
  let varridos = 0;
  let detalhados = 0;

  while (achados.length < limite && varridos < MAX_VARREDURA) {
    await respirar();
    const pagina = await evoClient.buscarMembros({ take: PAGINA, skip });
    if (!pagina.length) break;

    varridos += pagina.length;
    skip += pagina.length;

    for (const membro of pagina) {
      if (achados.length >= limite) break;

      const idMember = membro.idMember ?? membro.id;
      if (!idMember) continue;

      const phone = telefoneUtil(membro);
      if (!phone) continue;

      // Filtro barato antes do caro: se a listagem já diz que está ativo,
      // não vale gastar as duas chamadas de `situacaoDoMembro`.
      if (ativoNaListagem(membro)) continue;

      // Teto de consultas caras por rodada. Sem ele, uma base de milhares
      // vira milhares de PARES de requisições, e a cota de 40/min da conta
      // acaba — derrubando junto o atendimento, que usa a mesma API.
      if (detalhados >= MAX_DETALHES) {
        logger.warn(
          `[segmentos] Teto de ${MAX_DETALHES} consultas detalhadas atingido — ` +
          'coorte parcial. Rode de novo para continuar de onde parou.'
        );
        varridos = MAX_VARREDURA;
        break;
      }

      let situacao;
      try {
        detalhados++;
        await respirar();
        situacao = await evoClient.situacaoDoMembro(idMember, { mesesReativacao: mesesMin });
      } catch (err) {
        logger.debug(`[segmentos] Situação do membro ${idMember} falhou: ${err.message}`);
        continue;
      }

      if (situacao.ativo || !situacao.reativavel) continue;

      // Sem contrato nenhum: `situacaoDoMembro` marca como reativável, mas
      // para campanha isso é gente que nunca comprou — não há relação
      // comercial que sustente a abordagem. Fica de fora.
      if (situacao.mesesInativo === null) continue;
      if (situacao.mesesInativo > mesesMax) continue;

      achados.push({
        phone,
        nome: primeiroNome(membro.firstName || membro.name),
        evo_id_member: idMember,
        evo_id_prospect: null,
        contexto: {
          segmento: 'ex_aluno_reativavel',
          meses_inativo: situacao.mesesInativo,
          fim_ultimo_contrato: situacao.fimUltimoContrato,
          montado_em: new Date().toISOString().slice(0, 10),
        },
      });
    }

  }

  logger.info(`[segmentos] ex_aluno_reativavel: ${achados.length} de ${varridos} membros varridos`);
  return achados;
}

/**
 * Oportunidade antiga que nunca fechou.
 *
 * Prospect é gente que pediu informação e não voltou. A relação é mais
 * fraca que a do ex-aluno, então o padrão é uma janela curta: quem pediu
 * informação há dois anos não lembra da academia, e a mensagem chega como
 * abordagem fria.
 *
 * @param {object} [args]
 * @param {number} [args.diasMin] - Parado há pelo menos isto.
 * @param {number} [args.diasMax] - E no máximo isto.
 * @param {number} [args.limite]
 */
async function prospectFrio({ diasMin = 30, diasMax = 365, limite = 500 } = {}) {
  const achados = [];
  const agora = Date.now();
  const dia = 24 * 60 * 60 * 1000;
  let skip = 0;
  let varridos = 0;

  while (achados.length < limite && varridos < MAX_VARREDURA) {
    await respirar();
    const pagina = await evoClient.buscarProspects({ take: PAGINA, skip });
    if (!pagina.length) break;

    varridos += pagina.length;
    skip += pagina.length;

    for (const p of pagina) {
      if (achados.length >= limite) break;

      const phone = telefoneUtil(p);
      if (!phone) continue;

      // Já virou aluno: não é lead, e receber oferta de matrícula sendo
      // aluno é o erro que mais irrita.
      if (p.idMember) continue;

      const registro = p.registerDate || p.createdDate || p.insertDate;
      if (!registro) continue;

      const quando = new Date(registro).getTime();
      if (Number.isNaN(quando)) continue;

      const dias = Math.floor((agora - quando) / dia);
      if (dias < diasMin || dias > diasMax) continue;

      achados.push({
        phone,
        nome: primeiroNome(p.firstName || p.name),
        evo_id_member: null,
        evo_id_prospect: p.idProspect ?? p.id ?? null,
        contexto: {
          segmento: 'prospect_frio',
          dias_desde_cadastro: dias,
          interesse: p.interest || p.interests || null,
          montado_em: new Date().toISOString().slice(0, 10),
        },
      });
    }

  }

  logger.info(`[segmentos] prospect_frio: ${achados.length} de ${varridos} prospects varridos`);
  return achados;
}

/**
 * Aluno ATIVO — para venda cruzada (levar quem só faz musculação para a
 * natação, oferecer plano família a quem tem filho na escolinha).
 *
 * É o segmento de menor risco de todos: relação comercial em curso, a
 * pessoa conhece a academia e reconhece o número. Vale começar o piloto por
 * ele mesmo que o retorno por mensagem seja menor.
 *
 * @param {object} [args]
 * @param {number} [args.limite]
 */
async function alunoAtivo({ limite = 500 } = {}) {
  const achados = [];
  let skip = 0;
  let varridos = 0;

  while (achados.length < limite && varridos < MAX_VARREDURA) {
    await respirar();
    const pagina = await evoClient.buscarMembros({ take: PAGINA, skip });
    if (!pagina.length) break;

    varridos += pagina.length;
    skip += pagina.length;

    for (const membro of pagina) {
      if (achados.length >= limite) break;
      if (!ativoNaListagem(membro)) continue;

      const phone = telefoneUtil(membro);
      if (!phone) continue;

      achados.push({
        phone,
        nome: primeiroNome(membro.firstName || membro.name),
        evo_id_member: membro.idMember ?? membro.id ?? null,
        evo_id_prospect: null,
        contexto: {
          segmento: 'aluno_ativo',
          montado_em: new Date().toISOString().slice(0, 10),
        },
      });
    }

  }

  logger.info(`[segmentos] aluno_ativo: ${achados.length} de ${varridos} membros varridos`);
  return achados;
}

// ──────────────────────────────────────────────
// Registro
// ──────────────────────────────────────────────

const SEGMENTOS = {
  ex_aluno_reativavel: exAlunoReativavel,
  prospect_frio: prospectFrio,
  aluno_ativo: alunoAtivo,
};

export const NOMES_SEGMENTOS = Object.keys(SEGMENTOS);

/**
 * Monta a coorte de um segmento.
 *
 * @param {string} nome - Um de `NOMES_SEGMENTOS`
 * @param {object} [args] - Parâmetros do segmento (ver cada função)
 * @returns {Promise<Array<{phone:string, nome:string|null, evo_id_member:number|null, evo_id_prospect:number|null, contexto:object}>>}
 */
export async function montarSegmento(nome, args = {}) {
  const fn = SEGMENTOS[nome];
  if (!fn) {
    throw new Error(
      `Segmento "${nome}" não existe. Disponíveis: ${NOMES_SEGMENTOS.join(', ')}`
    );
  }

  logger.info(`[segmentos] Montando "${nome}" ${JSON.stringify(args)}`);
  const lista = await fn(args);

  // Um telefone pode aparecer duas vezes na base do EVO (cadastro
  // duplicado, mãe e filho no mesmo número). Duas mensagens iguais para o
  // mesmo aparelho é o erro mais visível que uma campanha comete.
  const porTelefone = new Map();
  for (const item of lista) {
    if (!porTelefone.has(item.phone)) porTelefone.set(item.phone, item);
  }

  const unicos = [...porTelefone.values()];
  if (unicos.length !== lista.length) {
    logger.info(`[segmentos] ${lista.length - unicos.length} telefone(s) repetido(s) descartado(s)`);
  }

  return unicos;
}

export const segmentos = { montarSegmento, NOMES_SEGMENTOS };
