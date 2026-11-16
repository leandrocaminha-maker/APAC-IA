/**
 * src/services/recomeco.js
 * A restrição da Meta como fato gravado, e o recomeço que sai dela.
 *
 * As regras estão em `recomeco-regras.js`. Aqui fica o que toca o banco e a
 * Evolution: gravar a queda, gravar a volta e dizer o teto de hoje a quem
 * pergunta (`limite-envio.js`).
 *
 * ## De onde vem a queda
 *
 * De dois lugares, porque nenhum dos dois cobre tudo:
 *
 * 1. O `connection.update` da Evolution (`webhook.js`), no segundo em que a
 *    sessão cai. Não cobre a queda que acontece com o backend reiniciando.
 * 2. O registro da própria Evolution (`disconnectionReasonCode` e
 *    `disconnectionAt` da instância), conferido pelo vigia a cada mudança de
 *    estado e na subida do backend. Ela só grava esses campos quando a
 *    sessão cai SEM reconectar sozinha, que é o caso que interessa.
 *
 * As duas leituras da mesma queda não viram duas quedas (`ehQuedaNova`).
 *
 * ## Onde fica gravado
 *
 * Em `crm_controle`, na chave `whatsapp_restricao`: `{ em, codigo,
 * voltou_em, encerrado_em }`. Precisa sobreviver a restart, e é um fato só.
 *
 * ## 401 nem sempre é a Meta
 *
 * Tirar o aparelho pelo celular ("Aparelhos conectados") chega com o mesmo
 * código. Tratar as duas coisas igual é o lado seguro: o custo é a régua
 * calada por uns dias, e `npm run recomeco -- encerrar` desfaz na hora.
 *
 * ## Falha fechada
 *
 * Sem conseguir ler o marcador (e sem leitura anterior para se apoiar), a
 * máquina não inicia conversa. É a mesma regra do teto: o erro custa uma
 * hora de follow-up atrasado contra mais uma restrição.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { listarInstancias } from './evolution.js';
import { CODIGOS_DE_QUEDA, ehQuedaNova, situacaoDoRecomeco } from './recomeco-regras.js';

const CHAVE = 'whatsapp_restricao';

// O teto é conferido antes de cada envio. Um minuto de memória evita uma ida
// ao banco por mensagem, e é o prazo em que um comando do script passa a valer.
const VALIDADE_MS = 60_000;

// Registro da Evolution mais velho que isto não vira restrição: a rampa já
// teria acabado, e o campo fica lá para sempre (o 401 de 23/09 ficou).
const REGISTRO_VELHO_MS = 14 * 24 * 60 * 60 * 1000;

let memoria = null;   // { lidaEm: number, restricao: object|null }

/**
 * O marcador gravado.
 * @returns {Promise<{ok: true, restricao: object|null} | {ok: false}>}
 */
async function ler({ fresca = false } = {}) {
  if (!fresca && memoria && Date.now() - memoria.lidaEm < VALIDADE_MS) {
    return { ok: true, restricao: memoria.restricao };
  }

  const { data, error } = await supabase
    .from('crm_controle')
    .select('valor')
    .eq('chave', CHAVE)
    .maybeSingle();

  if (error) {
    logger.error(`[recomeco] Não deu para ler a restrição gravada: ${error.message}`);
    // Uma leitura velha vale mais que nenhuma: a restrição não some sozinha.
    return memoria && !fresca ? { ok: true, restricao: memoria.restricao } : { ok: false };
  }

  const restricao = data?.valor?.em ? data.valor : null;
  memoria = { lidaEm: Date.now(), restricao };
  return { ok: true, restricao };
}

async function gravar(restricao) {
  const { error } = await supabase
    .from('crm_controle')
    .upsert({ chave: CHAVE, valor: restricao, updated_at: new Date().toISOString() }, { onConflict: 'chave' });

  if (error) {
    logger.error(`[recomeco] Não deu para gravar a restrição: ${error.message}`);
    return false;
  }
  memoria = { lidaEm: Date.now(), restricao };
  return true;
}

const rampa = () => config.envio.recomecoRampa;

/**
 * A sessão caiu sem volta.
 *
 * Uma queda nova durante o recomeço zera a contagem: a volta passa a ser a
 * próxima, e a rampa recomeça do primeiro degrau.
 *
 * @param {object} p
 * @param {string|Date} [p.em]
 * @param {number} [p.codigo]
 * @returns {Promise<boolean>} `true` quando gravou uma queda nova.
 */
export async function registrarQueda({ em = new Date(), codigo = null } = {}) {
  const lido = await ler({ fresca: true });
  if (!lido.ok || !ehQuedaNova(lido.restricao, em)) return false;

  const restricao = {
    em: new Date(em).toISOString(),
    codigo,
    voltou_em: null,
    encerrado_em: null,
  };
  if (!(await gravar(restricao))) return false;

  logger.error(
    `[recomeco] 🚨 Sessão derrubada pelo WhatsApp (código ${codigo ?? '?'}) em ${restricao.em}. ` +
    'A máquina não inicia conversa até o número voltar' +
    (rampa().length ? `, e depois segue a rampa ${rampa().join(', ')} (ENVIO_RECOMECO_RAMPA).` : '. ') +
    ' Responder a quem escreve segue liberado. Se não foi restrição: npm run recomeco -- encerrar.'
  );
  return true;
}

/**
 * A sessão conectou. Se havia queda sem volta gravada, a rampa começa agora.
 * @returns {Promise<boolean>} `true` quando gravou a volta.
 */
export async function registrarVolta(quando = new Date()) {
  const lido = await ler({ fresca: true });
  const atual = lido.ok ? lido.restricao : null;
  if (!atual || atual.voltou_em || atual.encerrado_em) return false;

  const restricao = { ...atual, voltou_em: new Date(quando).toISOString() };
  if (!(await gravar(restricao))) return false;

  const s = situacaoDoRecomeco({ restricao, rampa: rampa(), agora: new Date(quando) });
  logger.warn(`[recomeco] O número voltou. ${s.ativo ? s.motivo : 'Sem rampa configurada: vale o teto de regime.'}`);
  return true;
}

/** Encerra o recomeço à mão: volta a valer o teto de regime. */
export async function encerrar(quando = new Date()) {
  const lido = await ler({ fresca: true });
  if (!lido.ok || !lido.restricao || lido.restricao.encerrado_em) return false;
  return gravar({ ...lido.restricao, encerrado_em: new Date(quando).toISOString() });
}

/**
 * O `connection.update` da Evolution, para a instância principal.
 * @param {{estado: string, codigo?: number}} p
 */
export async function aoMudarConexao({ estado, codigo } = {}) {
  if (estado === 'open') return registrarVolta();
  if (estado === 'close' && CODIGOS_DE_QUEDA.includes(Number(codigo))) {
    return registrarQueda({ codigo: Number(codigo) });
  }
  return false;
}

/**
 * Confere com o registro da própria Evolution — cobre a queda que o webhook
 * não entregou (backend reiniciando) e a que aconteceu antes de este código
 * existir. Chamado pelo vigia a cada mudança de estado, inclusive na subida.
 *
 * @param {string} estado - O estado que o vigia acabou de ver.
 */
export async function conferirComAEvolution(estado) {
  try {
    const instancias = await listarInstancias();
    const minha = instancias.find(i => (i?.name || i?.instance?.instanceName) === config.evolution.instance);
    const codigo = Number(minha?.disconnectionReasonCode);
    const em = minha?.disconnectionAt;
    const recente = em && Date.now() - new Date(em).getTime() < REGISTRO_VELHO_MS;

    if (recente && CODIGOS_DE_QUEDA.includes(codigo)) await registrarQueda({ em, codigo });
  } catch (err) {
    logger.warn(`[recomeco] Não deu para conferir a queda com a Evolution: ${err.message}`);
  }

  if (estado === 'open') await registrarVolta();
}

/**
 * Em que ponto do recomeço o número está agora.
 *
 * `indisponivel` marca a leitura que falhou: quem chama trata como "não
 * pode enviar", nunca como "não há recomeço".
 *
 * @returns {Promise<{ativo: boolean, dia: number|null, teto: number|null, motivo?: string, indisponivel?: boolean, restricao?: object|null}>}
 */
export async function situacao(agora = new Date()) {
  if (!rampa().length) return { ativo: false, dia: null, teto: null, restricao: null };

  const lido = await ler();
  if (!lido.ok) {
    return {
      ativo: true, dia: null, teto: 0, indisponivel: true, restricao: null,
      motivo: 'não deu para conferir se o número está em recomeço — nada sai enquanto isso não puder ser conferido',
    };
  }
  return { ...situacaoDoRecomeco({ restricao: lido.restricao, rampa: rampa(), agora }), restricao: lido.restricao };
}

export const recomeco = {
  situacao, registrarQueda, registrarVolta, encerrar, aoMudarConexao, conferirComAEvolution,
};
