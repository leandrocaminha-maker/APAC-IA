/**
 * src/services/evo-client.js
 * Client para a API do EVO / W12 (sistema de gestão da academia).
 *
 * Basic Auth: usuário = DNS, senha = Token.
 * Base: https://evo-integracao-api.w12app.com.br
 *
 * ⚠️ Os caminhos aqui vieram do swagger oficial
 * (https://evo-integracao-api.w12app.com.br/swagger/v1/swagger.json),
 * conferido em 22/08/2026. Vale escrever porque a versão anterior deste
 * arquivo errava três deles e o erro só aparecia em runtime:
 *
 *   /api/v1/services  → 404. O certo é /api/v1/service (singular).
 *   /api/v1/members   → existe, mas a versão viva é /api/v2/members.
 *   POST /api/v1/members para criar prospect → cria MEMBRO, não prospect.
 *                     O certo é POST /api/v1/prospects.
 *
 * ⚠️ Armadilha do experimental-class: os campos vão na QUERY STRING, não
 * no corpo. Mandar JSON no body devolve 400 sem dizer por quê.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const { baseUrl, dns, token } = config.evo;
const authHeader = 'Basic ' + Buffer.from(`${dns}:${token}`).toString('base64');

/** Filial padrão. 1 = AP ACADEMIA - PIRITUBA. */
export const ID_BRANCH_PADRAO = config.evo.idBranch;

// ──────────────────────────────────────────────
// Regulagem de chamadas
//
// O EVO responde `429 API calls quota exceeded! maximum admitted 5 per 1s`.
// Nada no cliente respeitava isso: `sincronizarProspects` percorre os leads
// num laço `await` apertado, e um laço local faz dezenas de chamadas por
// segundo sem esforço. A guarda de aluno ativo da régua de silêncio somou
// mais 1 ou 2 chamadas por lead varrido, e em 28/08/2026 os primeiros 429
// apareceram.
//
// O espaçamento fica AQUI, e não em cada laço, porque o limite é da conta
// inteira: throttle por chamador não sabe do outro chamador, e dois laços
// educados somam 10/s. Aqui, todo caller passa pelo mesmo gargalo.
//
// 250ms = 4/s, com folga deliberada sob o teto de 5. O poll de 15 leads
// passa de instantâneo para ~4s, o que não importa num worker de 15 min.
// ──────────────────────────────────────────────

const INTERVALO_MIN_MS = 250;

let ultimaChamada = 0;

// A fila serializa apenas a AUTORIZAÇÃO, não a resposta: cada chamador
// espera a vez de partir, e a requisição em si segue concorrente. Uma
// corrente de promessas, e não um array, porque a ordem de chegada já é a
// ordem justa e não há prioridade a arbitrar.
let vez = Promise.resolve();

function aguardarVez() {
  vez = vez.then(async () => {
    const espera = INTERVALO_MIN_MS - (Date.now() - ultimaChamada);
    if (espera > 0) await new Promise(r => setTimeout(r, espera));
    ultimaChamada = Date.now();
  });
  return vez;
}

/** Teto de reenvios num 429. Só para leitura — ver `evoFetch`. */
const RETENTATIVAS_429 = 2;

/**
 * Erro de API do EVO com o status preservado.
 * Quem chama precisa distinguir "dado inválido" (4xx, não adianta repetir)
 * de "o EVO caiu" (5xx, vale enfileirar e tentar de novo).
 */
export class EvoApiError extends Error {
  constructor(status, path, body) {
    super(`EVO API ${status} em ${path}: ${String(body).slice(0, 400)}`);
    this.name = 'EvoApiError';
    this.status = status;
    this.path = path;
    this.body = body;
    this.retryable = status >= 500 || status === 429;
  }
}

/**
 * Helper para chamadas à API do EVO.
 *
 * Escritas passam pelo guarda de dry-run: com EVO_DRY_RUN=true nada sai
 * daqui, e a resposta é um objeto marcado com `dryRun: true`. Serve para
 * ensaiar o fluxo inteiro do painel sem criar prospect, aula ou venda de
 * mentira no sistema de produção da academia.
 */
async function evoFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  // `configuracao: true` marca escritas que são de INFRAESTRUTURA, não de
  // dado de cliente — hoje só o cadastro de webhooks. Elas passam pelo
  // dry-run de propósito.
  //
  // O dry-run existe para não criar prospect, aula e venda de mentira no
  // sistema da academia. Suprimir também o registro de webhook não protege
  // ninguém e produz o pior resultado possível: o painel dizia "6 webhooks
  // criados" e o EVO continuava com zero.
  const escrita = method !== 'GET' && !options.configuracao;

  if (escrita && config.evo.dryRun) {
    logger.warn(`[evo-w12] DRY-RUN: ${method} ${path} não foi enviado`);
    return { dryRun: true, method, path, body: options.body ? JSON.parse(options.body) : null };
  }

  const fullUrl = `${baseUrl}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: authHeader,
    ...options.headers,
  };

  if (escrita) logger.info(`[evo-w12] ${method} ${path}`);
  else logger.debug(`[evo-w12] ${method} ${path}`);

  const { configuracao: _ignorado, ...opcoesFetch } = options;

  // Reenvio SÓ em leitura, e isso não é excesso de zelo: `evoFetch` atende
  // GET e POST pelo mesmo caminho, e repetir o POST que cria prospect,
  // agenda aula ou registra venda criaria dois. Um 429 numa escrita sobe
  // para o chamador decidir — ele sabe se pode repetir, este helper não.
  const podeReenviar = method === 'GET';

  for (let tentativa = 0; ; tentativa++) {
    await aguardarVez();
    const res = await fetch(fullUrl, { ...opcoesFetch, headers });

    if (res.ok) {
      // Vários POSTs do EVO respondem 200 com corpo vazio.
      const texto = await res.text();
      if (!texto) return null;
      try {
        return JSON.parse(texto);
      } catch {
        return texto;
      }
    }

    const body = await res.text().catch(() => '');

    // O 429 vinha de uma rajada nossa: esperar um pouco mais que o
    // espaçamento normal costuma bastar, e o `aguardarVez` do próximo giro
    // já garante a distância mínima por cima disso.
    if (res.status === 429 && podeReenviar && tentativa < RETENTATIVAS_429) {
      const espera = INTERVALO_MIN_MS * (tentativa + 2);
      logger.warn(`[evo-w12] 429 em ${path} — reenviando em ${espera}ms ` +
        `(tentativa ${tentativa + 1}/${RETENTATIVAS_429})`);
      await new Promise(r => setTimeout(r, espera));
      continue;
    }

    logger.error(`[evo-w12] ${res.status} ${method} ${path}`, body.slice(0, 400));
    throw new EvoApiError(res.status, path, body);
  }
}

/** Monta query string ignorando null/undefined/''. */
function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) v.forEach(item => sp.append(k, String(item)));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Separa DDI do celular.
 *
 * O EVO guarda os dois em campos diferentes (`ddi` e `cellphone`), e os
 * cadastros existentes têm o celular SEM o 55 — "11985066934". Mandar
 * "5511985066934" no cellphone cria um número que não bate com nenhuma
 * busca posterior por telefone.
 */
export function separarDdi(telefone) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (digitos.startsWith('55') && digitos.length >= 12) {
    return { ddi: '55', cellphone: digitos.slice(2) };
  }
  return { ddi: '55', cellphone: digitos };
}

/** Data para o formato que o EVO aceita em birthday: YYYY-MM-DDT00:00:00 */
function dataEvo(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 10)}T00:00:00`;
}

// ──────────────────────────────────────────────
// Prospects (oportunidades)
// ──────────────────────────────────────────────

/**
 * Busca prospects. `take` é limitado a 50 pela própria API.
 * @param {object} params - { idProspect, name, document, email, phone,
 *                            registerDateStart, registerDateEnd,
 *                            conversionDateStart, conversionDateEnd, take, skip }
 */
export async function buscarProspects(params = {}) {
  const lista = await evoFetch(`/api/v1/prospects${qs({ ...params, take: Math.min(params.take || 50, 50) })}`);
  return Array.isArray(lista) ? lista : [];
}

/** Busca um prospect pelo id. Devolve null se não existir. */
export async function buscarProspectPorId(idProspect) {
  const [p] = await buscarProspects({ idProspect, take: 1 });
  return p || null;
}

/**
 * Busca prospect pelo celular. O EVO guarda sem DDI — normalizamos antes
 * para não errar a busca de quem foi cadastrado pelo WhatsApp (com 55).
 */
export async function buscarProspectPorTelefone(telefone) {
  const { cellphone } = separarDdi(telefone);
  if (!cellphone) return null;
  const lista = await buscarProspects({ phone: cellphone, take: 50 });
  return lista[0] || null;
}

/**
 * Cadastra um prospect (oportunidade) no EVO.
 *
 * @param {object} dados
 * @param {string} dados.nomeCompleto   - "Maria Silva Souza" (dividido em name/lastName)
 * @param {string} [dados.email]
 * @param {string} [dados.telefone]     - qualquer formato, com ou sem DDI
 * @param {string} [dados.dataNascimento] - YYYY-MM-DD
 * @param {string} [dados.genero]       - 'M' | 'F'
 * @param {string} [dados.observacoes]
 * @param {string} [dados.canal]        - mktChannel; default vem do config
 * @param {number[]} [dados.interesses] - ids de /api/v2/prospects/interests
 * @returns {Promise<{idProspect:number|null, dryRun?:boolean, raw:any}>}
 */
export async function criarProspect(dados) {
  const nome = String(dados.nomeCompleto || '').trim().replace(/\s+/g, ' ');
  const partes = nome.split(' ');
  const { ddi, cellphone } = separarDdi(dados.telefone);

  const body = {
    name: partes[0] || '',
    lastName: partes.slice(1).join(' ') || '',
    email: dados.email || null,
    idBranch: dados.idBranch || ID_BRANCH_PADRAO,
    ddi,
    cellphone,
    birthday: dataEvo(dados.dataNascimento),
    gender: dados.genero || null,
    notes: dados.observacoes || null,
    marketingType: dados.canal || config.evo.canalMarketing,
    interests: Array.isArray(dados.interesses) ? dados.interesses : [],
    // Sem CPF no cadastro do WhatsApp: pedir documento no primeiro contato
    // derruba conversão, e o EVO não exige. A validação fica desligada para
    // o campo vazio não virar 400.
    validateCpf: false,
    validateCpfDuplication: false,
  };

  const raw = await evoFetch('/api/v1/prospects', { method: 'POST', body: JSON.stringify(body) });

  if (raw?.dryRun === true) {
    return { idProspect: null, dryRun: true, raw };
  }

  // O EVO responde de formas diferentes conforme a versão: às vezes o id
  // puro, às vezes um objeto. Normalizamos para quem chama não precisar saber.
  const idProspect = typeof raw === 'number'
    ? raw
    : (raw?.idProspect ?? raw?.IdProspect ?? null);

  // Sem id não dá para seguir em frente, e o silêncio aqui é caro: quem
  // chama guardaria `null`, o lead continuaria "não cadastrado", e a
  // próxima ação do consultor tentaria criar o prospect **de novo** —
  // duplicando a oportunidade no EVO a cada clique. Melhor falhar alto e
  // com a resposta crua à vista, que é o que permite descobrir o formato
  // novo se o EVO mudar.
  if (idProspect == null) {
    throw new Error(
      'O EVO aceitou o cadastro mas não devolveu idProspect. ' +
      `Resposta crua: ${JSON.stringify(raw).slice(0, 300)}`
    );
  }

  return { idProspect, dryRun: false, raw };
}

/** Atualização parcial do prospect (só os campos enviados mudam). */
export async function atualizarProspect(idProspect, campos = {}) {
  const body = { idProspect, ...campos };
  if (campos.telefone) {
    const { ddi, cellphone } = separarDdi(campos.telefone);
    body.ddi = ddi;
    body.cellphone = cellphone;
    delete body.telefone;
  }
  if (campos.dataNascimento) {
    body.birthday = dataEvo(campos.dataNascimento);
    delete body.dataNascimento;
  }
  return evoFetch('/api/v1/prospects', { method: 'PATCH', body: JSON.stringify(body) });
}

/** Converte a oportunidade em membro. Devolve o idMember criado. */
export async function converterProspect(idProspect, idBranch = ID_BRANCH_PADRAO) {
  const raw = await evoFetch(`/api/v1/prospects/convert${qs({ idProspect, idBranch })}`, { method: 'POST' });
  const idMember = typeof raw === 'number' ? raw : (raw?.idMember ?? raw?.IdMember ?? null);
  return { idMember, raw };
}

/** Lista de interesses cadastrados na filial (para marcar a modalidade). */
export async function listarInteresses() {
  const lista = await evoFetch('/api/v2/prospects/interests');
  return Array.isArray(lista) ? lista : [];
}

// ──────────────────────────────────────────────
// Membros
// ──────────────────────────────────────────────

/** Busca membros. Filtros: name, email, document, phone, take, skip. */
export async function buscarMembros(params = {}) {
  const lista = await evoFetch(`/api/v2/members${qs({ ...params, take: params.take || 50 })}`);
  return Array.isArray(lista) ? lista : [];
}

/** Perfil completo de um membro. Traz `membershipStatus`, que a listagem não garante. */
export async function buscarMembroPorId(idMember) {
  return evoFetch(`/api/v2/members/${idMember}`);
}

/** Contratos (planos) de um membro, do mais antigo ao mais recente. */
export async function buscarContratosDoMembro(idMember) {
  const resposta = await evoFetch(`/api/v3/membermembership${qs({ idMember, take: 50 })}`);
  const lista = Array.isArray(resposta) ? resposta : (resposta?.list ?? resposta?.lista ?? []);
  return Array.isArray(lista) ? lista : [];
}

/**
 * Situação do aluno para efeito de funil.
 *
 * O EVO só sabe dizer `Active` / `Inactive` — não existe caminho de volta de
 * `member` para `prospect`, então quem se matriculou em 2018 e parou em 2021
 * continua sendo "aluno" para sempre. A academia não opera assim: passados
 * alguns meses sem contrato, a pessoa volta a ser oportunidade.
 *
 * Aqui juntamos as duas informações que o EVO tem em lugares diferentes — o
 * status do perfil e a data de fim do último contrato — para responder o que
 * de fato importa: **esta pessoa pode fazer aula experimental?**
 *
 * @returns {Promise<{ativo:boolean, mesesInativo:number|null, fimUltimoContrato:string|null, reativavel:boolean, membro:object}>}
 */
export async function situacaoDoMembro(idMember, { mesesReativacao = config.evo.mesesReativacao } = {}) {
  const membro = await buscarMembroPorId(idMember);
  const ativo = String(membro?.membershipStatus || '').toLowerCase() === 'active';

  if (ativo) {
    return { ativo: true, mesesInativo: 0, fimUltimoContrato: null, reativavel: false, membro };
  }

  const contratos = await buscarContratosDoMembro(idMember).catch(() => []);
  const fins = contratos
    .map(c => c.membershipEnd)
    .filter(Boolean)
    .map(d => new Date(d))
    .filter(d => !Number.isNaN(d.getTime()))
    .sort((a, b) => b - a);

  // Sem contrato nenhum: alguém cadastrado como membro que nunca fechou plano.
  // Conta como reativável — é lead, não aluno.
  const fim = fins[0] || null;
  const mesesInativo = fim
    ? Math.floor((Date.now() - fim.getTime()) / (1000 * 60 * 60 * 24 * 30.44))
    : null;

  return {
    ativo: false,
    mesesInativo,
    fimUltimoContrato: fim ? fim.toISOString().slice(0, 10) : null,
    reativavel: mesesInativo === null || mesesInativo >= mesesReativacao,
    membro,
  };
}

// ──────────────────────────────────────────────
// Aula experimental
// ──────────────────────────────────────────────

/**
 * Agenda uma aula experimental e matricula o prospect nela.
 *
 * ⚠️ Este endpoint recebe tudo por QUERY STRING — não tem corpo. Foi a
 * única forma que o swagger documenta, e mandar JSON no body dá 400 mudo.
 *
 * @param {object} dados
 * @param {number} dados.idProspect      - quem vai participar
 * @param {string} dados.dataHora        - 'YYYY-MM-DD HH:mm'
 * @param {string} [dados.atividade]     - nome da atividade (ex.: 'NATAÇÃO ADULTO')
 * @param {string} [dados.servico]       - serviço que autoriza a experimental
 * @param {number} [dados.idActivity]    - se souber o id, evita casar por nome
 * @param {number} [dados.idService]
 * @param {boolean} [dados.atividadeExiste] - true = usar sessão já existente na grade
 */
export async function agendarAulaExperimental(dados) {
  const params = {
    idProspect: dados.idProspect,
    activityDate: dados.dataHora,
    activity: dados.atividade,
    service: dados.servico,
    activityExist: dados.atividadeExiste,
    idBranch: dados.idBranch || ID_BRANCH_PADRAO,
    idActivity: dados.idActivity,
    idService: dados.idService,
  };
  return evoFetch(`/api/v1/activities/schedule/experimental-class${qs(params)}`, { method: 'POST' });
}

/**
 * O EVO está dizendo "já está agendado"?
 *
 * ⚠️ Ele sinaliza isso com **HTTP 400**, o que faz sucesso parecer falha.
 * A chave é `JaEstaNaAula` no experimental-class e "already booked" no
 * booking.
 *
 * Distinguir importa mais do que parece. Em 22/08/2026 a Leia agendou uma
 * aula, tentou confirmar de novo, leu o 400 como recusa e ofereceu outro
 * horário — que funcionou, gerou novo 400 na reconfirmação, e assim por
 * diante. O cliente terminou com três aulas no mesmo dia.
 *
 * Tratar como sucesso é o que torna o agendamento idempotente: repetir a
 * chamada leva ao mesmo estado final em vez de multiplicar reservas.
 */
export function ehJaAgendado(erro) {
  const texto = `${erro?.body ?? ''} ${erro?.message ?? ''}`;
  return /JaEstaNaAula|already booked|already enrolled|j[áa] est[áa] na aula/i.test(texto);
}

/** Sessões já reservadas por um prospect numa janela de datas. */
export async function sessoesDoProspect(idProspect, { de, ate } = {}) {
  return sessoesDaPessoa({ idProspect, de, ate });
}

/**
 * Sessões de uma pessoa — prospect OU aluno.
 *
 * Depois da aula, cada sessão traz `statusName`, `presenca`, `falta` e
 * `faltaJustificada`. É a única forma de saber se a pessoa apareceu, e é
 * o que separa "como foi a aula?" de uma mensagem para quem faltou.
 */
export async function sessoesDaPessoa({ idProspect, idMember, de, ate } = {}) {
  const lista = await evoFetch(`/api/v2/activities/member/sessions${qs({
    idProspect, idMember, dateStart: de, dateEnd: ate, take: 50,
  })}`);
  return Array.isArray(lista) ? lista : [];
}

/**
 * A pessoa compareceu à aula daquele dia?
 *
 * ⚠️ **"Presente" é o valor PADRÃO no EVO, não uma afirmação.** Todo
 * participante nasce com `status: 0` (Attending). Ler isso como presença
 * confirmada faria a Leia dizer "como foi a aula?" para quem não apareceu
 * — e não há como desfazer essa mensagem.
 *
 * O que é evidência de verdade:
 *
 * - **Falta** é confiável sempre. Ninguém "cai" em falta: alguém marcou.
 * - **Presente** só vale se a sessão foi **finalizada por gente**.
 *
 * E como saber se foi gente? A API não expõe timestamp de finalização —
 * conferido no swagger e nos payloads: existe só `status: 6 / Finalized`.
 * Sessão não fechada à mão é fechada automaticamente perto da meia-noite.
 * Logo, a evidência é **o momento em que observamos**: ver "Finalized"
 * enquanto ainda são menos de 22h do dia da aula significa que alguém
 * fechou antes do processo automático.
 *
 * Isso também cobre a cautela com prospect: sem finalização humana, um
 * prospect "presente" volta como `desconhecida`, e a Leia pergunta em vez
 * de afirmar.
 *
 * @returns {Promise<{resultado: 'presente'|'falta'|'falta_justificada'|'nao_finalizada'|'desconhecida',
 *                    confiavel: boolean, finalizada: boolean, observadoEm: string, motivo: string}>}
 */
export async function presencaNaAula({ idProspect, idMember, data }) {
  const agora = new Date();
  const dia = String(data).slice(0, 10);

  const sessoes = await sessoesDaPessoa({ idProspect, idMember, de: dia, ate: dia }).catch(() => []);

  const base = {
    confiavel: false,
    finalizada: false,
    observadoEm: agora.toISOString(),
  };

  if (!sessoes.length) {
    return { ...base, resultado: 'desconhecida', motivo: 'nenhuma sessão encontrada para o dia' };
  }

  const s = sessoes[0];
  const finalizada = s.isFinalized === true;

  // Falta exige ação de alguém — vale independentemente da finalização.
  if (s.faltaJustificada === true) {
    return { ...base, resultado: 'falta_justificada', confiavel: true, finalizada,
      motivo: 'falta justificada marcada por alguém' };
  }
  if (s.falta === true || /falta/i.test(s.statusName || '')) {
    return { ...base, resultado: 'falta', confiavel: true, finalizada,
      motivo: 'falta marcada por alguém' };
  }

  // Daqui para baixo o EVO diz "presente" — que é o default.
  // Limite de confiança: 22h do dia da aula, no horário de São Paulo.
  const limite = new Date(`${dia}T22:00:00-03:00`);
  const dentroDoPrazo = agora < limite;

  if (!finalizada) {
    return dentroDoPrazo
      ? { ...base, resultado: 'nao_finalizada', finalizada: false,
          motivo: 'sessão ainda aberta; vale reconsultar antes das 22h' }
      : { ...base, resultado: 'desconhecida', finalizada: false,
          motivo: 'sessão nunca foi finalizada e o prazo confiável passou' };
  }

  return dentroDoPrazo
    ? { ...base, resultado: 'presente', confiavel: true, finalizada: true,
        motivo: 'sessão finalizada antes das 22h — finalização humana' }
    : { ...base, resultado: 'desconhecida', finalizada: true,
        motivo: 'finalizada, mas só observada depois das 22h — pode ter sido automática' };
}

/**
 * Reserva alguém numa sessão que JÁ EXISTE na grade.
 *
 * Diferença para `agendarAulaExperimental`, e é o motivo de existir: este
 * endpoint **só reserva**. Não cria sessão e não vende serviço nenhum.
 *
 * Serve para quem já tem a aula experimental comprada — o ex-aluno que
 * comprou pelo cadastro de cliente, ou alguém sendo remarcado. Passar pelo
 * `experimental-class` nesses casos venderia o mesmo serviço de novo.
 *
 * ⚠️ Aceita `idProspect` ou `idMember`, mas **recusa membro inativo**
 * ("Agendamento indisponível pelo motivo: Inactive member") — testado nas
 * duas rotas e nos 14 valores de `origin`. Para ex-aluno, portanto, só
 * funciona pelo prospect.
 */
export async function reservarEmSessao({ idProspect, idMember, idConfiguration, data, slot, origem }) {
  const params = {
    idProspect,
    idMember,
    idConfiguration,
    activityDate: String(data).slice(0, 10),
    slotNumber: slot,
    origin: origem,
    idBranch: ID_BRANCH_PADRAO,
  };
  return evoFetch(`/api/v2/activities/booking${qs(params)}`, { method: 'POST' });
}

// ──────────────────────────────────────────────
// Atividades e grade
// ──────────────────────────────────────────────

/** Lista as modalidades/atividades da filial. */
export async function listarAtividades(params = {}) {
  const lista = await evoFetch(`/api/v1/activities${qs(params)}`);
  return Array.isArray(lista) ? lista : [];
}

/**
 * Grade horária.
 *
 * ⚠️ O campo de atividade inativa é `inactive`, NÃO `isActive`. Código que
 * filtra por `isActive !== false` deixa passar tudo, porque o campo não
 * existe — e aí atividade desativada aparece para o cliente.
 */
export async function buscarGrade(params = {}) {
  const lista = await evoFetch(`/api/v1/activities/schedule${qs(params)}`);
  return (Array.isArray(lista) ? lista : []).filter(a => a?.inactive !== true);
}

// ──────────────────────────────────────────────
// Serviços, planos e produtos
// ──────────────────────────────────────────────

/**
 * Desembrulha as respostas de catálogo do EVO.
 *
 * ⚠️ Elas não são todas do mesmo formato. `/api/v1/service` devolve um
 * array; `/api/v3/membership` devolve um objeto paginado
 * `{ qtde, lista, list, ... }` — e tratá-lo como array devolve vazio em
 * silêncio, que foi exatamente o que aconteceu: o painel mostrava zero
 * planos numa conta com 53 ativos.
 */
function desembrulhar(resposta) {
  if (Array.isArray(resposta)) return { itens: resposta, total: resposta.length };
  const itens = resposta?.list ?? resposta?.lista ?? [];
  return { itens: Array.isArray(itens) ? itens : [], total: resposta?.qtde ?? itens.length };
}

/**
 * Percorre um endpoint paginado até o fim.
 *
 * `take` é limitado a 50 pelo EVO nesses recursos. O teto de páginas evita
 * que um filtro mal montado vire uma varredura da base inteira — a conta
 * tem 518 planos históricos, e só ~53 interessam.
 */
async function paginar(caminho, params = {}, { maxPaginas = 6 } = {}) {
  const take = 50;
  const todos = [];

  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const resposta = await evoFetch(`${caminho}${qs({ ...params, take, skip: pagina * take })}`);
    const { itens, total } = desembrulhar(resposta);

    todos.push(...itens);
    if (itens.length < take || todos.length >= total) break;
  }

  return todos;
}

/**
 * Serviços avulsos (MATRÍCULA, AULA EXPERIMENTAL...). Note o singular no
 * caminho — `/api/v1/services` é 404.
 *
 * `active: true` por padrão: sem ele a listagem vem dominada por serviços
 * desativados, e oferecer serviço morto ao cliente é pior do que não
 * oferecer nada.
 */
export async function listarServicos(params = {}) {
  return paginar('/api/v1/service', { active: true, ...params });
}

/**
 * Planos / mensalidades.
 *
 * Mesma história do `active`, e mais grave aqui: a primeira página sem
 * filtro é inteira de planos de 2014, todos com `inactive: true`.
 */
export async function listarPlanos(params = {}) {
  return paginar('/api/v3/membership', { active: true, ...params });
}

/**
 * O serviço que autoriza a aula experimental.
 *
 * O endpoint de agendamento pede um `service`/`idService`, e a conta tem
 * um serviço marcado com `experimentalClass: true` (hoje o id 6, "AULA
 * EXPERIMENTAL", R$ 0). Procurar pela flag em vez de fixar o número
 * sobrevive a alguém recriar o serviço no EVO.
 */
export async function servicosDoMembro(idMember) {
  const lista = await evoFetch(`/api/v1/members/services${qs({ idMember })}`);
  return Array.isArray(lista) ? lista : [];
}

/**
 * O membro já comprou a aula experimental?
 *
 * Importa para ex-aluno reativado: o serviço pode já ter sido vendido no
 * cadastro de cliente (pelo painel ou pelo consultor). Agendar passando o
 * serviço de novo criaria uma segunda venda do mesmo item.
 */
export async function membroJaTemExperimental(idMember) {
  const servicos = await servicosDoMembro(idMember).catch(() => []);
  return servicos.some(s => s?.experimentalClass === true || /experimental/i.test(s?.nameService || ''));
}

export async function buscarServicoExperimental() {
  const servicos = await listarServicos();
  return servicos.find(s => s?.experimentalClass === true) || null;
}

// ──────────────────────────────────────────────
// Vendas
// ──────────────────────────────────────────────

/**
 * Registra uma venda.
 *
 * Casos que o EVO aceita (ver "Realizar venda online via API" na doc):
 *  - prospect + serviço  → idProspect + idService
 *  - prospect + plano    → idProspect + idMembership
 *  - membro  + plano     → memberData.idMember + idMembership
 *
 * @param {object} dados
 * @param {number} [dados.idProspect]
 * @param {number} [dados.idMember]
 * @param {number} [dados.idService]
 * @param {number} [dados.idMembership]
 * @param {number} [dados.valor]        - sobrescreve o valor de tabela
 * @param {number} [dados.formaPagamento] - EFormaPagamentoTotem (1 à vista, 5 parcelado, 6 outro)
 * @param {number} [dados.parcelas]
 * @param {string} [dados.voucher]
 * @param {string} [dados.inicioPlano]  - YYYY-MM-DD
 */
export async function criarVenda(dados) {
  const body = {
    idBranch: dados.idBranch || ID_BRANCH_PADRAO,
    payment: dados.formaPagamento ?? 6,
  };

  if (dados.idProspect) body.idProspect = dados.idProspect;
  if (dados.idMember) body.memberData = { idMember: dados.idMember };

  if (dados.idMembership) {
    body.idMembership = dados.idMembership;
    if (dados.valor != null) body.membershipValue = dados.valor;
    if (dados.inicioPlano) body.membershipStart = dados.inicioPlano;
  }
  if (dados.idService) {
    body.idService = dados.idService;
    if (dados.valor != null) body.serviceValue = dados.valor;
  }
  if (dados.parcelas) body.totalInstallments = dados.parcelas;
  if (dados.voucher) body.voucher = dados.voucher;

  const raw = await evoFetch('/api/v2/sales', { method: 'POST', body: JSON.stringify(body) });
  const idSale = typeof raw === 'number' ? raw : (raw?.idSale ?? raw?.IdSale ?? null);
  return { idSale, dryRun: raw?.dryRun === true, raw };
}

/** Consulta vendas. Filtros úteis: idMember, dateSaleStart, dateSaleEnd. */
export async function buscarVendas(params = {}) {
  const lista = await evoFetch(`/api/v2/sales${qs({ take: 25, ...params })}`);
  return Array.isArray(lista) ? lista : [];
}

/** Detalhe de uma venda. */
export async function buscarVendaPorId(idSale) {
  return evoFetch(`/api/v2/sales/${idSale}`);
}

// ──────────────────────────────────────────────
// Follow-up (notificações do EVO)
//
// É o que aparece para o consultor dentro do EVO como pendência do
// prospect. Não é mensagem para o cliente — é recado interno.
// ──────────────────────────────────────────────

/** Lança um follow-up na ficha do prospect. */
export async function lancarFollowUpProspect(idProspect, mensagem) {
  return evoFetch('/api/v1/notifications/prospect', {
    method: 'POST',
    body: JSON.stringify({ idProspect, notificationMessage: mensagem }),
  });
}

/** Lança um follow-up na ficha do membro. */
export async function lancarFollowUpMembro(idMember, mensagem) {
  return evoFetch('/api/v1/notifications', {
    method: 'POST',
    body: JSON.stringify({ idMember, notificationMessage: mensagem }),
  });
}

// ──────────────────────────────────────────────
// Webhooks
// ──────────────────────────────────────────────

/** Lista os webhooks cadastrados na conta. */
export async function listarWebhooks() {
  const lista = await evoFetch('/api/v2/webhook');
  return Array.isArray(lista) ? lista : [];
}

/**
 * Cadastra um webhook.
 * @param {string} eventType - ver EVENTOS_WEBHOOK
 * @param {string} urlCallback
 * @param {Array<{nome:string, valor:string}>} [headers]
 */
export async function criarWebhook(eventType, urlCallback, headers = []) {
  return evoFetch('/api/v1/webhook', {
    method: 'POST',
    configuracao: true,
    body: JSON.stringify({
      idBranch: ID_BRANCH_PADRAO,
      eventType,
      urlCallback,
      headers,
      filters: [],
    }),
  });
}

/** Remove um webhook pelo id. */
export async function removerWebhook(idWebhook) {
  return evoFetch(`/api/v1/webhook${qs({ IdWebhook: idWebhook })}`, {
    method: 'DELETE',
    configuracao: true,
  });
}

/**
 * Eventos que este projeto assina.
 *
 * ⚠️ Repare no que NÃO está aqui: não existe evento de mudança de etapa
 * ou de status de prospect no EVO. A lista completa da doc é de criação e
 * alteração de membro, contrato, produto, serviço, venda, matrícula em
 * atividade e transferência — nada sobre a evolução da oportunidade.
 * Por isso o funil também depende do poller (evo-sync.js).
 */
export const EVENTOS_WEBHOOK = [
  'NewSale',           // venda registrada → lead vira 'ganho'
  'RecurrentSale',     // recorrência
  'CreateMember',      // prospect virou aluno
  'CreateMembership',  // contrato criado
  'ActivityEnroll',    // matrícula em aula — é como a experimental aparece
  'TransferProspect',  // oportunidade mudou de filial
];

export const evoClient = {
  // prospects
  buscarProspects,
  buscarProspectPorId,
  buscarProspectPorTelefone,
  criarProspect,
  atualizarProspect,
  converterProspect,
  listarInteresses,
  // membros
  buscarMembros,
  buscarMembroPorId,
  buscarContratosDoMembro,
  situacaoDoMembro,
  // experimental e grade
  agendarAulaExperimental,
  reservarEmSessao,
  ehJaAgendado,
  sessoesDoProspect,
  sessoesDaPessoa,
  presencaNaAula,
  listarAtividades,
  buscarGrade,
  // catálogo
  listarServicos,
  listarPlanos,
  buscarServicoExperimental,
  servicosDoMembro,
  membroJaTemExperimental,
  // vendas
  criarVenda,
  buscarVendas,
  buscarVendaPorId,
  // follow-up
  lancarFollowUpProspect,
  lancarFollowUpMembro,
  // webhooks
  listarWebhooks,
  criarWebhook,
  removerWebhook,
  EVENTOS_WEBHOOK,
  // utilidades
  separarDdi,
  ID_BRANCH_PADRAO,
};
