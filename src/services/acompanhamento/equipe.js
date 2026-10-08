/**
 * src/services/acompanhamento/equipe.js
 * A equipe do acompanhamento: o código EQUIPE e as mensagens de quem ativou.
 *
 * O professor gera no Prescrev o próprio código e manda "EQUIPE <código>" ao
 * WhatsApp da academia (§7.2 do PLANO_ACOMPANHAMENTO.md do Prescrev, D4).
 * Aqui o código é conferido contra a lista que o Prescrev publica, o número
 * de quem mandou fica gravado em `acomp_equipe`, o contato vira 'equipe' e a
 * resposta confirma. É resposta a mensagem recebida: não conta no teto.
 *
 * ## Por que antes do funil
 *
 * Mensagem de quem é da equipe não é conversa de venda. Sem esta porta, o
 * "1" com que o professor responde a um encaminhamento viraria lead no funil
 * e a Leia responderia a ele como a um cliente. Ela vem logo depois do
 * "SAIR" no webhook, e devolve `true` quando a mensagem é dela.
 *
 * ## O código vale como senha
 *
 * Quem ativar recebe encaminhamentos com dado de saúde de alunos. O código
 * tem 6 caracteres de 32 (~10⁹); errar 5 vezes em 24h cala a porta para
 * aquele número — sem resposta, para não ensinar a tentar.
 */
import { supabase } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { buscarEquipe } from './prescrev.js';
import { lerComandoEquipe, lerRespostaDoBriefing, textoDeConfirmacao } from './comandos.js';
import { responderBriefing } from './encaminhamentos.js';

const TENTATIVAS_MAX = 5;
const TENTATIVAS_JANELA_MS = 24 * 60 * 60_000;

const tentativas = new Map(); // phone -> [instantes das falhas]
function bloqueado(phone) {
  const recentes = (tentativas.get(phone) ?? []).filter(t => Date.now() - t < TENTATIVAS_JANELA_MS);
  tentativas.set(phone, recentes);
  return recentes.length >= TENTATIVAS_MAX;
}

/** Quem da equipe tem este número, ou null. */
export async function membroDaEquipe(phone) {
  const { data, error } = await supabase.from('acomp_equipe').select('*').eq('phone', phone).maybeSingle();
  if (error) {
    // Antes da 014 a tabela não existe: ninguém é da equipe.
    if (error.code !== 'PGRST205') logger.warn('[equipe] Não deu para ler acomp_equipe:', error.message);
    return null;
  }
  return data;
}

async function ativar({ phone, contact, codigo, responder }) {
  if (bloqueado(phone)) return;

  let lista;
  try {
    // Código recém-gerado ainda não está no cache: na dúvida, busca de novo.
    lista = await buscarEquipe();
    if (!lista.some(m => m.codigo_equipe === codigo)) lista = await buscarEquipe({ fresca: true });
  } catch (err) {
    logger.error('[equipe] Prescrev não respondeu à lista da equipe:', err.message);
    await responder('Não consegui conferir o código agora. Tente de novo em alguns minutos.');
    return;
  }

  const membro = lista.find(m => m.codigo_equipe === codigo);
  if (!membro) {
    tentativas.set(phone, [...(tentativas.get(phone) ?? []), Date.now()]);
    logger.warn(`[equipe] Código EQUIPE não reconhecido vindo de ${phone}`);
    await responder('Código não reconhecido. Confira o seu código na tela Acompanhamento do Prescrev.');
    return;
  }

  // Uma pessoa, um número: o aparelho anterior sai.
  await supabase.from('acomp_equipe').delete().eq('profile_id', membro.profile_id).neq('phone', phone);
  const { error } = await supabase.from('acomp_equipe').upsert({
    phone, profile_id: membro.profile_id, nome: membro.nome, papel: membro.papel, codigo,
    ativado_em: new Date().toISOString(),
  }, { onConflict: 'phone' });
  if (error) {
    logger.error('[equipe] Não deu para gravar a ativação:', error.message);
    await responder('Não consegui registrar agora. Tente de novo em alguns minutos.');
    return;
  }

  const { error: errTipo } = await supabase.from('wa_contacts').update({ tipo_contato: 'equipe' }).eq('id', contact.id);
  if (errTipo) logger.warn('[equipe] Contato não marcado como equipe (a 013 foi aplicada?):', errTipo.message);

  if (membro.whatsapp_cadastro && !phone.endsWith(membro.whatsapp_cadastro.slice(-8))) {
    logger.info(`[equipe] ${membro.nome} ativou de um número diferente do cadastro do AQUAP — vale o que mandou o código`);
  }
  logger.info(`[equipe] ${membro.nome} (${membro.papel}) ativou o WhatsApp para encaminhamentos`);
  await responder(textoDeConfirmacao(membro));
}

/**
 * A porta da equipe no webhook. Devolve true quando a mensagem é dela — o
 * comando EQUIPE, de qualquer número, ou qualquer mensagem de quem já é da
 * equipe —, e aí o funil e a Leia não a veem.
 *
 * @param {{ phone: string, contact: object, content: string, responder: (texto: string) => Promise<void> }} p
 */
export async function tratarMensagemDaEquipe({ phone, contact, content, responder }) {
  const codigo = lerComandoEquipe(content);
  if (codigo !== null) {
    if (codigo === '') {
      if (!bloqueado(phone)) await responder('Para ativar, mande EQUIPE seguido do código de 6 letras e números da tela Acompanhamento do Prescrev.');
      return true;
    }
    await ativar({ phone, contact, codigo, responder });
    return true;
  }

  const membro = await membroDaEquipe(phone);
  if (!membro) return false;

  // 1, 2 ou 3: a resposta ao encaminhamento mais recente que espera por ele.
  const resposta = lerRespostaDoBriefing(content);
  if (resposta) {
    await responder(await responderBriefing({ phone, numero: resposta.numero, nota: resposta.nota }));
    logger.info(`[equipe] ${membro.nome} respondeu ${resposta.numero} a um encaminhamento`);
    return true;
  }

  // Qualquer outra mensagem fica gravada, e ninguém responde por máquina.
  logger.info(`[equipe] Mensagem de ${membro.nome} registrada, fora do funil`);
  return true;
}

export const equipeAcompanhamento = { tratarMensagemDaEquipe, lerComandoEquipe, membroDaEquipe, textoDeConfirmacao };
