/**
 * src/services/acompanhamento/carteira-treinos.js
 * A carteira de treinos de musculação (migration 023).
 *
 * Quem é da carteira diz o EVO, por uma segmentação do CRM que chega ao
 * webhook um POST por pessoa, SEM a descrição da comunicação — é o que a
 * separa da coorte de campanha (`campanhas.absorverSegmentacao` exige a
 * descrição). O treino de cada um se lê aqui, uma vez por dia, e o Prescrev
 * mostra ao professor e à coordenação (rota /acompanhamento/carteira-treinos).
 *
 * Nada aqui manda mensagem: é leitura para o painel.
 */
import { logger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { treinosDoAluno } from '../evo-client.js';
import { resumirTreinos } from './regua.js';

/** Horas até reler o treino de quem já foi lido. */
export const RELER_HORAS = 20;

/**
 * A segmentação da carteira: `crm.segmentation.*` sem a descrição da
 * comunicação e com o número do aluno. A de campanha traz a descrição.
 */
export function ehSegmentacaoDaCarteira(envelope) {
  const tipo = String(envelope?.EventType || envelope?.eventType || '');
  if (!tipo.startsWith('crm.segmentation')) return false;
  if (envelope?.communication?.message?.trim()) return false;
  return Number.isInteger(envelope?.person?.idMember) && envelope.person.idMember > 0;
}

/** A linha da carteira que o evento traz. Puro. */
export function linhaDaSegmentacao(envelope, agora = new Date()) {
  const p = envelope.person;
  return {
    id_member: p.idMember,
    nome: (p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ')).trim() || null,
    plano: envelope?.membership?.[0]?.nameMembership?.trim() || null,
    status_evo: p.status ?? null,
    segmentado_em: agora.toISOString(),
  };
}

/** Põe (ou mantém) a pessoa na carteira. O treino se lê depois, no worker. */
export async function registrarNaCarteira(envelope) {
  const { error } = await supabase.from('acomp_carteira_treinos')
    .upsert(linhaDaSegmentacao(envelope), { onConflict: 'id_member' });
  if (error) throw new Error(`carteira de treinos: ${error.message}`);
}

/**
 * Lê no EVO o treino de quem ainda não foi lido ou foi lido há mais de
 * `RELER_HORAS`, `limite` por ciclo e 3 de cada vez — o EVO não gosta de
 * rajada. A falha de um não para os outros, e conta como lida: tenta de novo
 * no dia seguinte, e não a cada ciclo.
 *
 * @returns {Promise<{ lidos: number, erros: number }>}
 */
export async function atualizarCarteira({ limite = 120 } = {}) {
  const corte = new Date(Date.now() - RELER_HORAS * 3600_000).toISOString();
  const { data, error } = await supabase.from('acomp_carteira_treinos')
    .select('id_member').or(`lido_em.is.null,lido_em.lt.${corte}`)
    .order('lido_em', { ascending: true, nullsFirst: true }).limit(limite);
  if (error) throw new Error(`carteira de treinos: ${error.message}`);
  const fila = (data ?? []).map(r => r.id_member);
  let lidos = 0, erros = 0;
  const um = async (id) => {
    const lido_em = new Date().toISOString();
    try {
      const treinos = resumirTreinos(await treinosDoAluno(id));
      await supabase.from('acomp_carteira_treinos').update({ treinos, lido_em, erro: null }).eq('id_member', id);
      lidos++;
    } catch (err) {
      await supabase.from('acomp_carteira_treinos').update({ lido_em, erro: String(err.message).slice(0, 300) }).eq('id_member', id);
      erros++;
    }
  };
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(3, fila.length) }, async () => {
    while (i < fila.length) await um(fila[i++]);
  }));
  if (fila.length) logger.info(`[carteira-treinos] ${lidos} lido(s), ${erros} erro(s), de ${fila.length}`);
  return { lidos, erros };
}

/** A carteira inteira, para o Prescrev. */
export async function lerCarteira() {
  const linhas = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase.from('acomp_carteira_treinos')
      .select('id_member, nome, plano, status_evo, segmentado_em, treinos, lido_em, erro')
      .order('id_member').range(de, de + 999);
    if (error) throw new Error(`carteira de treinos: ${error.message}`);
    linhas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return linhas;
}
