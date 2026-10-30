/**
 * src/services/acompanhamento/relatorios.js
 * O relatório em PDF no WhatsApp do aluno (30/10/2026).
 *
 * Decisão do responsável: o Relatório 1 e o relatório completo vão em PDF a
 * quem ACEITOU o acompanhamento e ATIVOU o código — o Relatório 1 assim que
 * a pessoa ativa, o completo quando é gerado, e a versão corrigida quando o
 * relatório é reaberto e gerado de novo.
 *
 * ## Quem faz o quê
 *
 * O Prescrev publica: o PDF nasce no navegador de quem gera ou abre o
 * relatório (o mesmo do "Baixar PDF"), vai a um bucket privado de lá e entra
 * na lista da rota assinada /api/acompanhamento/relatorios — só de quem
 * mantém o aceite. Daqui sai o envio, e a tabela `acomp_relatorios` (021) é
 * o que já saiu: uma linha por versão publicada.
 *
 * ## Quando sai
 *
 *   na ativação   `ativacao.js` chama com `emResposta`, logo depois do aceite:
 *                 é resposta a quem acabou de escrever, e sai já, a qualquer
 *                 hora (como o próprio aceite)
 *   no worker     a cada ciclo dos encaminhamentos, só dentro da janela de
 *                 contato e com cota no teto do número: o completo gerado, a
 *                 versão corrigida, a inscrição confirmada pela equipe, o envio
 *                 que falhou (até 3 tentativas)
 *
 * Só a inscrição ATIVA recebe — a pendente (número diferente do cadastro,
 * esperando a equipe) não: o código está impresso, e quem pegar o papel não
 * pode receber o relatório de outra pessoa. Número suprimido também não.
 *
 * De cada relatório sai só a versão mais nova; a anterior que não saiu fica
 * `substituido`. "Corrigida" é a versão que chega a quem RECEBEU uma
 * anterior — quem ativa depois da correção recebe a frase de sempre.
 *
 * A mensagem sai como `bot:acompanhamento` (conta no teto do número, e a
 * resposta do aluno vai à Leia do acompanhamento). Desligado com
 * `ACOMPANHAMENTO_DRY_RUN`, como o resto do envio real.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { sendMediaBase64 } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { dentroDaJanela } from '../followup.js';
import { estaSuprimido } from '../campanhas.js';
import { limiteEnvio } from '../limite-envio.js';
import { SENT_BY_REGUA } from './conversa.js';
import { baixarRelatorio, buscarRelatorios } from './prescrev.js';

export const TENTATIVAS_MAX = 3;

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * O que sai agora, e o que fica substituído. PURO.
 *
 * @param {object[]} publicados  a lista do Prescrev: { id, cliente_id, tipo, versao, ... }
 * @param {object[]} registros   `acomp_relatorios` desses clientes
 * @param {Map<string, object>} ativas  cliente_id → inscrição ATIVA
 * @returns {{ enviar: {relatorio: object, inscricao: object, corrigido: boolean, tentativas: number}[], substituidos: object[] }}
 */
export function relatoriosParaEnviar(publicados, registros, ativas) {
  const registroDe = new Map(registros.map(r => [r.relatorio_id, r]));
  const porRelatorio = new Map();
  for (const p of publicados) {
    const k = `${p.cliente_id}/${p.tipo}`;
    porRelatorio.set(k, [...(porRelatorio.get(k) ?? []), p]);
  }

  const enviar = [];
  const substituidos = [];
  for (const versoes of porRelatorio.values()) {
    const ordem = [...versoes].sort((a, b) => Date.parse(b.versao) - Date.parse(a.versao));
    const [nova, ...antigas] = ordem;
    // A versão antiga que não saiu não sai mais: a nova a substitui.
    for (const a of antigas) {
      const r = registroDe.get(a.id);
      if (!r || r.status === 'falhou') substituidos.push(a);
    }
    const inscricao = ativas.get(nova.cliente_id);
    if (!inscricao) continue;
    const reg = registroDe.get(nova.id);
    if (reg && (reg.status === 'enviado' || reg.status === 'substituido')) continue;
    if (reg?.status === 'falhou' && (reg.tentativas ?? 0) >= TENTATIVAS_MAX) continue;
    const corrigido = registros.some(r => r.cliente_id === nova.cliente_id && r.tipo === nova.tipo &&
      r.status === 'enviado' && r.relatorio_id !== nova.id);
    enviar.push({ relatorio: nova, inscricao, corrigido, tentativas: reg?.tentativas ?? 0 });
  }
  return { enviar, substituidos };
}

/** A frase que vai junto do PDF, com o primeiro nome. PURO. */
export function legendaDoRelatorio(mensagens, relatorio, corrigido) {
  const modelo = (corrigido ? mensagens.corrigido : mensagens[relatorio.tipo]) ?? '';
  const nome = relatorio.primeiro_nome?.trim();
  return nome ? modelo.replace(/\{nome\}/g, nome) : modelo.replace(/^\{nome\},\s*/, '').replace(/^./, c => c.toUpperCase());
}

let enviando = false;

/**
 * Manda o que está pendente. `clienteId` restringe a um aluno (a ativação);
 * `emResposta` dispensa a janela de contato e o teto: é resposta a quem
 * acabou de escrever. Devolve quantos saíram. Nunca lança.
 */
export async function enviarRelatorios({ agora = new Date(), clienteId = null, emResposta = false } = {}) {
  if (config.acompanhamento.dryRun) return 0;
  if (!emResposta && dentroDaJanela(agora).getTime() !== agora.getTime()) return 0;
  // Uma rodada por vez: a ativação que chega no meio do worker fica para o ciclo seguinte dele.
  if (enviando) return 0;
  enviando = true;
  try {
    let lista;
    try {
      lista = await buscarRelatorios();
    } catch (err) {
      logger.warn('[relatorios] Lista do Prescrev não lida:', err.message);
      return 0;
    }
    const publicados = lista.relatorios.filter(p => !clienteId || p.cliente_id === clienteId);
    if (!publicados.length) return 0;

    const clientes = [...new Set(publicados.map(p => p.cliente_id))];
    const [{ data: inscricoes, error: erroInscricoes }, { data: registros, error: erroRegistros }] = await Promise.all([
      supabase.from('acomp_inscricoes').select('cliente_id, phone, contact_id, status').eq('status', 'ativa').in('cliente_id', clientes),
      supabase.from('acomp_relatorios').select('relatorio_id, cliente_id, tipo, status, tentativas').in('cliente_id', clientes),
    ]);
    if (erroRegistros) {
      logger.warn(`[relatorios] acomp_relatorios não responde${erroRegistros.code === 'PGRST205' ? ' — rode a migration 021' : ''}: ${erroRegistros.message}`);
      return 0;
    }
    if (erroInscricoes) { logger.warn('[relatorios] Inscrições não lidas:', erroInscricoes.message); return 0; }

    const ativas = new Map((inscricoes ?? []).map(i => [i.cliente_id, i]));
    const { enviar, substituidos } = relatoriosParaEnviar(publicados, registros ?? [], ativas);
    for (const s of substituidos) {
      await supabase.from('acomp_relatorios').upsert({
        relatorio_id: s.id, cliente_id: s.cliente_id, tipo: s.tipo, versao: s.versao, status: 'substituido',
      }, { onConflict: 'relatorio_id' });
    }

    let enviados = 0;
    for (const { relatorio, inscricao, corrigido, tentativas } of enviar) {
      const registro = { relatorio_id: relatorio.id, cliente_id: relatorio.cliente_id, tipo: relatorio.tipo,
        versao: relatorio.versao, phone: inscricao.phone, corrigido, tentativas: tentativas + 1 };
      try {
        if (await estaSuprimido(inscricao.phone)) continue;
        if (!emResposta) {
          const cota = await limiteEnvio.podeIniciarConversa();
          if (!cota.ok) { logger.info(`[relatorios] Teto do número: ${cota.motivo}. Fica para o próximo ciclo.`); break; }
        }
        // Número Baileys não manda rajada.
        if (enviados > 0) await esperar(20_000 + Math.random() * 20_000);

        const arquivo = await baixarRelatorio(relatorio.id);
        const legenda = legendaDoRelatorio(lista.mensagens, relatorio, corrigido);
        const r = await sendMediaBase64(inscricao.phone, {
          base64: arquivo.base64, mimetype: arquivo.mimetype ?? 'application/pdf',
          fileName: arquivo.nome_arquivo ?? relatorio.nome_arquivo, caption: legenda, mediatype: 'document',
        });
        const contato = await getOrCreateContact(inscricao.phone, null);
        const conversa = await getOrCreateConversation(contato.id);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: legenda,
          contentType: 'document', sentBy: SENT_BY_REGUA, evolutionMsgId: r?.key?.id || null, status: 'sent',
          metadata: { acompanhamento: 'relatorio', relatorio: relatorio.id, tipo: relatorio.tipo, versao: relatorio.versao, corrigido },
        });
        await supabase.from('acomp_relatorios').upsert({
          ...registro, status: 'enviado', enviado_em: new Date().toISOString(), ultimo_erro: null,
        }, { onConflict: 'relatorio_id' });
        enviados++;
        logger.info(`[relatorios] Enviado: ${relatorio.tipo}${corrigido ? ' (corrigido)' : ''} ao cliente ${relatorio.cliente_id}`);
      } catch (err) {
        logger.error(`[relatorios] ${relatorio.tipo} do cliente ${relatorio.cliente_id} falhou: ${err.message}`);
        await supabase.from('acomp_relatorios').upsert({
          ...registro, status: 'falhou', ultimo_erro: String(err.message).slice(0, 500),
        }, { onConflict: 'relatorio_id' }).then(() => {}, () => {});
      }
    }
    return enviados;
  } finally {
    enviando = false;
  }
}
