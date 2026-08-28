/**
 * src/services/controle.js
 * Marcadores de worker que precisam sobreviver a restart.
 *
 * Uma chave, um instante, e contexto opcional junto. Existe porque relógio
 * em memória mente: `ultimaVarredura` zerava no boot, e três deploys num
 * dia transformaram o teto de "15 por hora" em "15 por deploy" — 45
 * mensagens onde a régua prometia 15.
 *
 * Falha ABERTA de propósito. Se a leitura do marcador falhar, o worker
 * segue com o comportamento antigo (roda a varredura) em vez de travar. O
 * pior caso é uma varredura a mais, que o teto de lote já limita; travar a
 * régua inteira porque uma tabela auxiliar não respondeu seria pior.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

/**
 * Quando este marcador foi carimbado pela última vez.
 * @returns {Promise<{quando: Date, valor: object}|null>}
 */
export async function lerMarcador(chave) {
  const { data, error } = await supabase
    .from('crm_controle')
    .select('valor, updated_at')
    .eq('chave', chave)
    .maybeSingle();

  if (error) {
    logger.warn(`[controle] Não deu para ler "${chave}": ${error.message}`);
    return null;
  }
  if (!data) return null;

  return { quando: new Date(data.updated_at), valor: data.valor ?? {} };
}

/**
 * Carimba o marcador agora.
 *
 * `updated_at` explícito, e não só o trigger: no INSERT o trigger de
 * `BEFORE UPDATE` não roda, e o marcador nasceria com o DEFAULT — que por
 * acaso também é NOW(), mas depender disso é depender de coincidência.
 */
export async function carimbarMarcador(chave, valor = {}) {
  const { error } = await supabase
    .from('crm_controle')
    .upsert({ chave, valor, updated_at: new Date().toISOString() }, { onConflict: 'chave' });

  if (error) logger.warn(`[controle] Não deu para carimbar "${chave}": ${error.message}`);
  return !error;
}

/**
 * Passou tempo suficiente desde o último carimbo?
 *
 * Marcador ausente conta como "sim": a primeira execução depois da
 * migration precisa rodar. Erro de leitura também — ver falha aberta.
 */
export async function passouDe(chave, minutos) {
  const marca = await lerMarcador(chave);
  if (!marca) return true;
  return Date.now() - marca.quando.getTime() >= minutos * 60_000;
}

export const controle = { lerMarcador, carimbarMarcador, passouDe };
