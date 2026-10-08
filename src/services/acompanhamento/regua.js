/**
 * src/services/acompanhamento/regua.js
 * A régua do acompanhamento: o que sai hoje para um aluno, e por quê.
 *
 * PURO, como `render.js`: recebe a ficha, os modelos, o histórico e o dia,
 * e devolve a decisão. O banco, a hora e o teto ficam em `ensaio.js`.
 *
 * ## O que esta versão decide (etapa A2, em ensaio)
 *
 * As situações que saem só da ficha do Prescrev:
 *
 *   boas_vindas  a primeira mensagem. No envio real, quem a manda é a
 *                ativação pelo código (etapa A5), em resposta ao aluno; no
 *                ensaio, ela abre a linha do tempo de quem acabou de chegar.
 *   reavaliacao  7 dias antes da próxima avaliação, uma vez por data.
 *   rotina       passou a cadência do aluno desde a última mensagem. Toda
 *                mensagem conta, de qualquer situação: evento zera o
 *                relógio da rotina (§5.4 do plano).
 *
 * Ausência, retorno, marco, ciclo em risco, treino vencendo e modalidade
 * sem agendamento dependem do EVO e entram com a leitura dele. A trilha é a
 * principal: a troca da adesão pela secundária quando a presença
 * estabiliza (§5.3) também espera a presença.
 *
 * ## Uma por dia
 *
 * Uma situação por aluno por dia, na ordem de PRIORIDADE. A decisão sempre
 * traz o motivo — inclusive quando nada sai —, porque é a prévia que se lê
 * antes de a régua falar com alguém, e discordar dela exige saber por quê.
 */
import { diasEntre, preencher, valoresDaFicha } from './render.js';

export const PRIORIDADE = { boas_vindas: 0, reavaliacao: 1, rotina: 2 };

/** Quantos dias antes da próxima avaliação sai o aviso. Convenção desta casa (§5.2). */
export const REAVALIACAO_ANTES_DIAS = 7;

const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Os modelos candidatos de uma situação para uma trilha. Rotina é sempre
 * da trilha; nas outras, o modelo da trilha vem antes do de 'todas'.
 */
export function candidatosDe(modelos, situacao, trilha) {
  const da = modelos.filter(m => m.situacao === situacao && m.trilha === trilha);
  if (situacao === 'rotina' || da.length) return da;
  return modelos.filter(m => m.situacao === situacao && m.trilha === 'todas');
}

/**
 * Rodízio: começa no modelo seguinte ao último usado nesta situação, para
 * a mesma pessoa não ler a mesma frase duas vezes seguidas. Modelo editado
 * no Prescrev ganha id novo, e o rodízio recomeça do primeiro.
 */
export function emRodizio(candidatos, ultimoId) {
  const i = candidatos.findIndex(m => m.id === ultimoId);
  return i < 0 ? candidatos : [...candidatos.slice(i + 1), ...candidatos.slice(0, i + 1)];
}

/** A situação devida hoje, ou o motivo de nada estar devido. */
export function situacaoDoDia({ ficha, anteriores, hoje, modo }) {
  if (!anteriores.length) {
    return modo === 'ensaio'
      ? { situacao: 'boas_vindas', motivo: 'Primeira mensagem. No envio real, sai quando o aluno ativa pelo código.' }
      : { situacao: null, motivo: 'Aguardando a ativação pelo código.' };
  }

  const prox = ficha.proxima_avaliacao;
  if (prox) {
    const ate = diasEntre(hoje, prox);
    const jaAvisou = anteriores.some(h => h.situacao === 'reavaliacao'
      && h.dia <= prox && diasEntre(h.dia, prox) <= REAVALIACAO_ANTES_DIAS);
    if (ate >= 0 && ate <= REAVALIACAO_ANTES_DIAS && !jaAvisou) {
      return {
        situacao: 'reavaliacao',
        motivo: ate === 0 ? `Reavaliação hoje (${ddmm(prox)}).` : `Reavaliação em ${ate} dia(s), em ${ddmm(prox)}.`,
      };
    }
  }

  const ultimo = anteriores[anteriores.length - 1];
  const desde = diasEntre(ultimo.dia, hoje);
  const cadencia = ficha.trilha.cadencia_dias;
  if (desde >= cadencia) {
    return { situacao: 'rotina', motivo: `${desde} dia(s) desde a última mensagem; cadência de ${cadencia}.` };
  }
  return {
    situacao: null,
    motivo: `Próxima rotina em ${cadencia - desde} dia(s): cadência de ${cadencia}, última em ${ddmm(ultimo.dia)}.`,
  };
}

/**
 * A decisão do dia para um aluno.
 *
 * @param {object} p
 * @param {object} p.ficha      a ficha publicada pelo Prescrev
 * @param {object[]} p.modelos  os modelos publicados pelo Prescrev
 * @param {object[]} p.historico as mensagens que contam (no ensaio, as
 *   simuladas; no envio, as enviadas): `{ dia, situacao, modelo_id }`
 * @param {string} p.hoje       'AAAA-MM-DD', em São Paulo
 * @param {'ensaio'|'envio'} p.modo
 * @returns {{ status: 'simulado'|'pendente'|'bloqueado'|'nada', situacao: string|null, trilha: string,
 *   modelo_id: string|null, texto: string|null, valores: object, motivo: string, bloqueios: string[] }}
 */
export function decidir({ ficha, modelos, historico, hoje, modo }) {
  const trilha = ficha.trilha.principal;
  const base = { trilha, situacao: null, modelo_id: null, texto: null, valores: {}, bloqueios: [] };

  if (ficha.estado?.encerrado) {
    return { ...base, status: 'nada', motivo: 'Acompanhamento encerrado no Prescrev.' };
  }
  if (ficha.estado?.pausado_ate && ficha.estado.pausado_ate >= hoje) {
    return { ...base, status: 'nada', motivo: `Pausado até ${ddmm(ficha.estado.pausado_ate)}.` };
  }

  // Só o que veio antes de hoje: rodar o ensaio duas vezes no mesmo dia
  // não pode fazer o relógio andar duas vezes.
  const anteriores = historico.filter(h => h.dia < hoje).sort((a, b) => a.dia.localeCompare(b.dia));
  const { situacao, motivo } = situacaoDoDia({ ficha, anteriores, hoje, modo });
  if (!situacao) return { ...base, status: 'nada', motivo };

  const valores = valoresDaFicha(ficha, hoje);
  const ultimoId = [...anteriores].reverse().find(h => h.situacao === situacao)?.modelo_id ?? null;
  const candidatos = emRodizio(candidatosDe(modelos, situacao, trilha), ultimoId);

  const faltam = new Set();
  for (const m of candidatos) {
    // 'nao' = marcador que nada preenche: fica para o professor mandar à mão.
    if (m.envio === 'nao') continue;
    const r = preencher(m.texto, valores);
    if (r.texto) {
      return {
        ...base, situacao, modelo_id: m.id, texto: r.texto, valores,
        status: modo === 'ensaio' ? 'simulado' : 'pendente', motivo,
      };
    }
    r.faltam.forEach(f => faltam.add(f));
  }

  const porque = !candidatos.length
    ? `Nenhum modelo de ${situacao} para a trilha ${trilha}.`
    : `Nenhum modelo de ${situacao} com todos os marcadores` +
      (faltam.size ? `: falta ${[...faltam].map(f => `{${f}}`).join(', ')}.` : '.');
  return { ...base, situacao, valores, status: 'bloqueado', motivo, bloqueios: [porque] };
}

// São Paulo é UTC-3 o ano todo — a mesma constante de followup.js.
const OFFSET_SP_MS = -3 * 60 * 60 * 1000;

/** Minuto do dia em que a mensagem de cada período sai, antes de presa à janela. */
const INICIO_DO_PERIODO = { 'manhã': 9 * 60, tarde: 14 * 60, noite: 18 * 60 };

/**
 * A hora prevista de uma mensagem: o começo do período preferido, presa à
 * janela do dia, mais um deslocamento fixo por aluno (0 a 40 min) para as
 * mensagens não saírem todas no mesmo minuto.
 */
export function horaPrevista(ficha, hoje, janela) {
  const base = INICIO_DO_PERIODO[ficha.marcadores?.periodo] ?? 10 * 60;
  let h = 0;
  for (const c of ficha.cliente_id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const minuto = Math.min(Math.max(base, janela.inicioMin) + (h % 41), janela.fimMin - 15);
  const [a, m, d] = hoje.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d, 0, minuto) - OFFSET_SP_MS);
}

