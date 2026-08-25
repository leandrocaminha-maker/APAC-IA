/**
 * src/services/transcricao.js
 * Transcrição de áudio recebido pelo WhatsApp.
 *
 * ## Por que existe um serviço de fora aqui
 *
 * O Claude não aceita áudio. Não é escolha de custo nem de arquitetura:
 * não existe caminho pela API da Anthropic para isto, então a transcrição
 * acontece fora dela em qualquer cenário.
 *
 * A opção local (whisper.cpp) foi medida e descartada: na VPS de 2 vCPU e
 * ~1,9 GB livres, o modelo que caberia leva 20 a 40 segundos para um áudio
 * de 30s. Somado aos 12s de agrupamento, o cliente esperaria quase um
 * minuto — e os ~350 MB de RAM disputariam espaço com o container que
 * atende. O Groq faz o mesmo em 1 a 2 segundos por menos de um centavo a
 * cada dez áudios.
 *
 * ## O que este arquivo NÃO decide
 *
 * Não decide o que responder. Ele devolve texto ou `null`. Quem trata a
 * falha é o webhook, e o comportamento na falha é o mesmo de sempre: pedir
 * que a pessoa mande por escrito. Áudio é 0,9% das mensagens — não vale
 * derrubar o atendimento por causa de um serviço de transcrição fora do ar.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Baixa a mídia de uma mensagem pela Evolution.
 *
 * A Evolution guarda o arquivo e o devolve em base64 a partir do id da
 * mensagem — o mesmo `evolution_msg_id` que já gravamos em `wa_messages`.
 * Por isso dá para transcrever inclusive áudio antigo, sem ter guardado o
 * arquivo em lugar nenhum.
 *
 * @param {string} evolutionMsgId
 * @returns {Promise<{base64:string, mimetype:string, fileName:string}|null>}
 */
export async function baixarMidia(evolutionMsgId) {
  if (!evolutionMsgId) return null;

  const url = `${config.evolution.url}/chat/getBase64FromMediaMessage/${config.evolution.instance}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify({ message: { key: { id: evolutionMsgId } }, convertToMp4: false }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      logger.warn(`[transcricao] Evolution devolveu ${res.status} ao baixar ${evolutionMsgId}`);
      return null;
    }

    const dado = await res.json();
    if (!dado?.base64) return null;

    return {
      base64: dado.base64,
      mimetype: dado.mimetype || 'audio/ogg',
      fileName: dado.fileName || `${evolutionMsgId}.oga`,
    };
  } catch (err) {
    logger.warn(`[transcricao] Falha ao baixar mídia ${evolutionMsgId}: ${err.message}`);
    return null;
  }
}

/**
 * Transcreve um áudio.
 *
 * O WhatsApp manda Opus dentro de OGG, que o Whisper aceita direto — não é
 * preciso converter, e converter na VPS custaria o CPU que estamos
 * justamente tentando não gastar.
 *
 * @param {string} evolutionMsgId
 * @returns {Promise<string|null>} O texto, ou null se não deu.
 */
export async function transcreverAudio(evolutionMsgId) {
  if (!config.transcricao.apiKey) {
    logger.debug('[transcricao] Sem GROQ_API_KEY — transcrição desligada');
    return null;
  }

  const midia = await baixarMidia(evolutionMsgId);
  if (!midia) return null;

  const bytes = Buffer.from(midia.base64, 'base64');

  // Áudio muito longo quase sempre é engano (gravação acidental no bolso),
  // e é o que mais custa tempo e dinheiro. O teto é generoso para recado
  // de verdade e corta o resto.
  if (bytes.length > config.transcricao.maxBytes) {
    logger.info(
      `[transcricao] Áudio de ${(bytes.length / 1024 / 1024).toFixed(1)} MB acima do teto — ignorado`
    );
    return null;
  }

  const inicio = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: midia.mimetype }), midia.fileName);
    form.append('model', config.transcricao.modelo);
    // Dizer o idioma melhora a precisão e evita que um "oi" solto seja
    // interpretado como outra língua.
    form.append('language', 'pt');
    form.append('response_format', 'text');

    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.transcricao.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(config.transcricao.timeoutMs),
    });

    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      logger.warn(`[transcricao] Groq devolveu ${res.status}: ${corpo.slice(0, 200)}`);
      return null;
    }

    const texto = (await res.text()).trim();
    const ms = Date.now() - inicio;

    if (!texto) {
      logger.info(`[transcricao] Áudio sem fala reconhecível (${ms}ms)`);
      return null;
    }

    logger.info(
      `[transcricao] ${(bytes.length / 1024).toFixed(0)}KB → ${texto.length} chars em ${ms}ms`
    );
    return texto;
  } catch (err) {
    logger.warn(`[transcricao] Falhou em ${Date.now() - inicio}ms: ${err.message}`);
    return null;
  }
}

export const transcricao = { baixarMidia, transcreverAudio };
