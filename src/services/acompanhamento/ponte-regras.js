/**
 * src/services/acompanhamento/ponte-regras.js
 * As regras da ponte professor ↔ aluno (A5d). PURO: sem banco e sem envio —
 * o que vai e volta pelo WhatsApp está em `ponte.js`.
 *
 * ## Por que a citação é o endereço
 *
 * O professor fala com vários alunos pelo mesmo número da academia. A única
 * coisa que diz, sem adivinhar, para quem vai uma mensagem dele é a mensagem
 * que ele CITOU (arrastou para o lado): o briefing ou um repasse do aluno. Sem
 * citação nada vai a aluno nenhum — dado de saúde entregue à pessoa errada
 * não tem volta (decisão do responsável em 09/10/2026).
 *
 * ## Quem falou o quê
 *
 *   professor:<profile_id>  o que o professor escreveu, na conversa do ALUNO
 *                           (não é `human:` — o follow-up de vendas contaria
 *                           como "nossa fala", e a conversa iria para o modo
 *                           humano do painel)
 *   bot:ponte               o repasse do aluno, na conversa do PROFESSOR, e o
 *                           aviso de espera ao aluno quando não há Leia
 */
import { emHorario, proximoInicio } from './horario.js';

export const SENT_BY_PONTE = 'bot:ponte';
export const sentByProfessor = (profileId) => `professor:${profileId}`;
export const ehDoProfessor = (sentBy) => String(sentBy ?? '').startsWith('professor:');

/** Sem mensagem nos dois sentidos por 72 h, a ponte fecha e o aluno volta à Leia. */
export const PRAZO_DA_PONTE_MS = 72 * 3_600_000;
/** O professor escreveu há menos que isto: a conversa está acontecendo, e a resposta vai na hora. */
export const AO_VIVO_MS = 30 * 60_000;

/** O que se repassa. Figurinha, contato e localização não. */
export const TIPOS_REPASSADOS = ['text', 'audio', 'image', 'video', 'document'];

/**
 * O id da mensagem citada, ou null. A Evolution v2 copia o `contextInfo` para
 * o topo do evento; o WhatsApp o põe dentro do tipo da mensagem
 * (`extendedTextMessage`, `audioMessage`, `imageMessage`…). Lê os dois.
 * @param {object} data  `event.data` do webhook
 */
export function idDaCitacao(data) {
  if (data?.contextInfo?.stanzaId) return data.contextInfo.stanzaId;
  for (const msg of [data?.message, data?.message?.message]) {
    if (!msg || typeof msg !== 'object') continue;
    for (const parte of Object.values(msg)) {
      const id = parte?.contextInfo?.stanzaId;
      if (id) return id;
    }
  }
  return null;
}

/**
 * "1", "2" ou "3" sozinho. Citando o briefing, é o comando daquele
 * encaminhamento; com qualquer texto junto, é mensagem ao aluno — "2 vezes
 * por semana está ótimo" não pode virar "já resolvi".
 * @returns {'1'|'2'|'3'|null}
 */
export function comandoSozinho(texto) {
  const m = /^\s*([123])\s*[.!]?\s*$/.exec(String(texto ?? ''));
  return m ? m[1] : null;
}

/** O que o aluno lê: assinado como o painel do CRM assina ("*Shirlei:*"). */
export function textoAoAluno(nome, texto) {
  return `*${nome}:*\n${texto}`;
}

/** A linha antes do áudio do professor — áudio não tem legenda. */
export const cabecalhoDeAudio = (nome) => `*${nome}:* 🎤`;

/** A legenda da foto ou do vídeo do professor. "[imagem]" é marcador nosso, não legenda. */
export function legendaAoAluno(nome, texto) {
  const legenda = /^\[(imagem|vídeo|documento)\]$/.test(String(texto ?? '').trim()) ? '' : String(texto ?? '').trim();
  return legenda ? textoAoAluno(nome, legenda) : `*${nome}:*`;
}

/** Os balões de texto do aluno numa mensagem só ao professor. */
export function textoAoProfessor(aluno, textos) {
  return [`💬 *${aluno}:*`, ...textos].join('\n');
}

/** A linha antes do áudio, ou a legenda da mídia, do aluno ao professor. */
export function cabecalhoAoProfessor(aluno, tipo, texto) {
  if (tipo === 'audio') return `💬 *${aluno}:* 🎤`;
  const legenda = /^\[[^\]]+\]$/.test(String(texto ?? '').trim()) ? '' : String(texto ?? '').trim();
  return legenda ? `💬 *${aluno}:*\n${legenda}` : `💬 *${aluno}*`;
}

/** A ponte passou do prazo sem mensagem? */
export function ponteVencida(ponte, agora = new Date()) {
  return !ponte.fechada_em && agora.getTime() - new Date(ponte.ultima_em).getTime() > PRAZO_DA_PONTE_MS;
}

/**
 * Quando a mensagem do aluno vai ao professor. Mensagem à equipe só no
 * horário de trabalho de quem recebe (08/10/2026) — salvo o professor estar
 * conversando agora: escreveu pela ponte há menos de 30 minutos.
 * @returns {{ acao: 'agora' } | { acao: 'turno', enviarEm: Date } | { acao: 'sem_horario' }}
 */
export function quandoRepassar({ horario, ultimaDoProfessorEm, agora = new Date() }) {
  if (ultimaDoProfessorEm && agora.getTime() - new Date(ultimaDoProfessorEm).getTime() < AO_VIVO_MS) return { acao: 'agora' };
  if (emHorario(horario, agora)) return { acao: 'agora' };
  const proximo = proximoInicio(horario, agora);
  return proximo ? { acao: 'turno', enviarEm: proximo } : { acao: 'sem_horario' };
}

/**
 * Quando o professor fica sabendo, por extenso, a partir de `professorHoje`
 * (horario.js). Nunca quando ele responde: regra do responsável de 08/10/2026.
 */
export function quandoFicaSabendo(situacao) {
  if (!situacao) return 'assim que possível';
  if (situacao.estado === 'agora') return 'agora';
  if (situacao.estado === 'mais_tarde') return `hoje às ${situacao.as}`;
  const dia = situacao.volta === 'amanhã' ? 'amanhã'
    : `${['sábado', 'domingo'].includes(situacao.volta) ? 'no' : 'na'} ${situacao.volta}`;
  return `${dia} às ${situacao.as}`;
}

/** O aviso fixo ao aluno quando a mensagem espera o turno e não há Leia (teste, aluno sem inscrição). */
export function textoDeEspera(professor, situacao) {
  return `Recebi e passei para ${professor}, que vê a mensagem ${quandoFicaSabendo(situacao)} 👍`;
}

/** O que volta ao professor quando a mensagem dele não foi. Sempre com a reação ⚠️. */
export const TEXTOS_PONTE = {
  ajuda: 'Para escrever a um aluno, responda *citando* a mensagem dele ou a do encaminhamento (arraste a mensagem ' +
    'para o lado). Assim ela vai para a pessoa certa. Esta não foi enviada a ninguém.',
  suprimido: (aluno) => `⚠️ ${aluno} pediu para não receber mensagens deste número. Nada foi enviado.`,
  semNumero: (aluno) => `⚠️ Não tenho o WhatsApp de ${aluno} neste encaminhamento. Nada foi enviado.`,
  falhou: (aluno) => `⚠️ Não consegui enviar para ${aluno} agora. Tente de novo em alguns minutos.`,
  midia: '⚠️ Não consegui pegar este arquivo para repassar. Tente mandar de novo.',
  tipo: '⚠️ Este tipo de mensagem não é repassado. Mande texto, áudio, foto ou vídeo.',
  ensaio: '⚠️ Este encaminhamento é de ensaio: nada vai ao aluno.',
};
