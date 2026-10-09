/**
 * src/services/acompanhamento/comandos.js
 * Os comandos que a equipe manda ao WhatsApp da academia, e os textos de
 * volta. PURO, para os testes rodarem sem `.env` nem banco.
 */
import { treinoVigente } from './regua.js';
import { primeiroNome } from './render.js';
import { quandoEnviar, temHorario } from './horario.js';

/** O código EQUIPE: o mesmo alfabeto do código de ativação do Prescrev (codigos.ts). */
const ALFABETO = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * O código de "EQUIPE K7P2QX" (espaços e caixa à vontade).
 *
 *   'K7P2QX'  comando com código no formato
 *   ''        tem cara de comando (EQUIPE + 4 a 10 letras e números), e o
 *             código não está no formato: a resposta ensina o formato
 *   null      não é comando — "Equipe de natação tem vaga?" é de cliente, e
 *             segue para o funil e a Leia
 */
export function lerComandoEquipe(texto) {
  const m = /^\s*equipe\s+([a-z0-9 ]+?)\s*$/i.exec(String(texto ?? ''));
  if (!m) return null;
  const codigo = m[1].replace(/\s+/g, '').toUpperCase();
  if (codigo.length < 4 || codigo.length > 10) return null;
  return ALFABETO.test(codigo) ? codigo : '';
}

/**
 * A confirmação, pelo papel e pelo horário: o coordenador também recebe o que
 * o professor não assume, e nada chega fora do horário de trabalho — nem a
 * quem ainda não tem horário no Prescrev.
 */
export function textoDeConfirmacao(membro) {
  const extra = membro.papel === 'coordinator'
    ? ' Como coordenação, você também recebe os que o professor não assumir.'
    : '';
  const quando = temHorario(membro.horario)
    ? 'os encaminhamentos dos seus alunos chegam aqui, só no seu horário de trabalho.'
    : 'número registrado. Ainda não há horário de trabalho seu no Prescrev: até a coordenação cadastrar, nenhum encaminhamento chega.';
  return `Pronto, ${membro.nome}: ${quando}${extra} Em teste: por enquanto só chegam encaminhamentos de teste.`;
}

// ──────────────────────────────────────────────
// Ativação do aluno: "ATIVAR <código>" (A5, §5.1 do plano)
// ──────────────────────────────────────────────

/**
 * O código de "ATIVAR K7P2QX". Mais estreito que o EQUIPE, porque quem manda
 * é qualquer pessoa: só seis letras e números fazem cara de código — "ativar
 * meu plano" é de cliente, e segue para o funil.
 *
 *   'K7P2QX'  comando com código no formato
 *   ''        seis caracteres fora do alfabeto: a resposta ensina
 *   null      não é comando
 */
export function lerComandoAtivar(texto) {
  const m = /^\s*ativar\s+([a-z0-9 ]+?)\s*$/i.exec(String(texto ?? ''));
  if (!m) return null;
  const codigo = m[1].replace(/\s+/g, '').toUpperCase();
  if (codigo.length !== 6) return null;
  return ALFABETO.test(codigo) ? codigo : '';
}

/**
 * O mesmo número? Pelos 8 últimos dígitos: o WhatsApp às vezes chega sem o
 * nono dígito do celular, e o cadastro do EVO às vezes vem sem o DDI.
 */
export function mesmoNumero(a, b) {
  const [x, y] = [a, b].map(n => String(n ?? '').replace(/\D/g, '').slice(-8));
  return x.length === 8 && x === y;
}

/** "a cada 3 dias", "uma vez por semana", "a cada duas semanas". */
export function cadenciaPorExtenso(dias) {
  if (dias === 7) return 'uma vez por semana';
  if (dias === 14) return 'a cada duas semanas';
  if (dias === 1) return 'todo dia';
  return `a cada ${dias} dias`;
}

/**
 * O aceite, na hora do ATIVAR (decisão do responsável em 08/10/2026): o mesmo
 * para todos, com o nome do professor e a cadência. É o que o aluno aceita —
 * o que vai receber, de quanto em quanto tempo, que o professor fica sabendo
 * quando ele conta dor ou dificuldade, e como parar. A boas-vindas da trilha
 * vem depois, pela régua. O professor só pelo nome: o cadastro não diz gênero.
 */
export function textoDoAceite({ nome, professor, cadenciaDias }) {
  return [
    `Pronto${nome ? `, ${nome}` : ''}! Seu acompanhamento está ativo 🙌`,
    '',
    `Por aqui você vai receber mensagens sobre o seu programa — ${cadenciaDias ? `mais ou menos ${cadenciaPorExtenso(cadenciaDias)}` : 'de tempos em tempos'}, ` +
      'e também perto da reavaliação ou quando você ficar uns dias sem vir. Pode responder quando quiser.',
    '',
    professor
      ? `Se contar alguma dor ou dificuldade, ${professor}, que acompanha você na academia, fica sabendo e fala com você.`
      : 'Se contar alguma dor ou dificuldade, a equipe que acompanha você na academia fica sabendo e fala com você.',
    '',
    'Para pausar, mande *PAUSAR ACOMPANHAMENTO*. Para não receber mais nada, *SAIR*.',
  ].join('\n');
}

/** Respostas da ativação. Sem o nome do aluno onde o número ainda não é dele. */
export const TEXTOS_ATIVACAO = {
  pendente: 'Recebi o código 👍 Como este número é diferente do que está no cadastro da academia, a equipe confirma ' +
    'antes de o acompanhamento começar. Avisamos por aqui.',
  invalido: 'Código não reconhecido. Confira o código no seu relatório, ou fale com a equipe na academia.',
  formato: 'Para ativar, mande ATIVAR seguido do código de 6 letras e números que está no seu relatório.',
  jaAtivo: 'Seu acompanhamento já está ativo por aqui 😊',
  aguardando: 'O código já chegou: a equipe ainda vai confirmar este número. Avisamos por aqui.',
  outroAluno: 'Este número já está com o acompanhamento de outra pessoa. Fale com a equipe na academia.',
};

// ──────────────────────────────────────────────
// Encaminhamentos: o briefing e as respostas 1/2/3
// ──────────────────────────────────────────────

const TRILHA = { adesao: 'adesão', motivacional: 'motivacional', tecnico: 'técnica', desafiador: 'desafiadora' };
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** O que a ficha diz do combinado, numa linha: "5× por semana: Musculação, Mat Pilates". */
export function combinadoDaFicha(ficha) {
  if (!ficha) return null;
  const freq = ficha.frequencia?.dias_semana ? `${ficha.frequencia.dias_semana}× por semana` : null;
  const modalidades = (ficha.modalidades ?? []).map(m => m.nome).join(', ');
  return [freq, modalidades].filter(Boolean).join(': ') || null;
}

/** A trilha e a reavaliação, numa linha: "desafiadora (2ª técnica) · reavaliação 21/11". */
export function acompanhamentoDaFicha(ficha) {
  if (!ficha) return null;
  const t = ficha.trilha ?? {};
  const trilha = TRILHA[t.principal] ? `${TRILHA[t.principal]}${t.secundaria ? ` (2ª ${TRILHA[t.secundaria]})` : ''}` : null;
  const reav = ficha.proxima_avaliacao ? `reavaliação ${ddmm(ficha.proxima_avaliacao)}` : null;
  return [trilha, reav].filter(Boolean).join(' · ') || null;
}

/**
 * O briefing ao professor (§7.4 do plano). Modelo fixo: o dado de saúde é o
 * mínimo — motivo, resumo, combinado —, e o resto fica atrás do link do
 * Prescrev, que pede login e permissão.
 *
 * Não leva o número do aluno (A5d, 09/10/2026): o professor fala com ele
 * citando este briefing, pelo número da academia, e ninguém vê o número de
 * ninguém. `ponte` diz se há WhatsApp do aluno para isso.
 */
export function textoDoBriefing({
  teste = false, repasse = null, aluno, idade = null, motivo, urgencia, resumo = null,
  combinado = null, acompanhamento = null, ponte = false, linkFicha = null,
}) {
  return [
    teste ? '🧪 *TESTE — não é de um aluno de verdade*' : null,
    '📋 *Acompanhamento — encaminhamento*',
    repasse ? `*Repassado:* ${repasse}` : null,
    `*Aluno(a):* ${aluno}${idade ? `, ${idade} anos` : ''}`,
    `*Motivo:* ${motivo} — *${urgencia === 'hoje' ? 'responder hoje' : 'nos próximos dias'}*`,
    resumo ? `*Resumo:* ${resumo}` : null,
    combinado ? `*Combinado:* ${combinado}` : null,
    acompanhamento ? `*Acompanhamento:* ${acompanhamento}` : null,
    linkFicha ? `Ficha: ${linkFicha}` : null,
    ponte
      ? `💬 Para falar com ${aluno}, responda a esta mensagem (arraste para o lado): vai pelo número da academia, com o seu nome.`
      : null,
    'Responda *1* eu assumo · *2* já resolvi · *3* não é comigo',
  ].filter(Boolean).join('\n');
}

/**
 * A resposta do professor a um briefing: o número e o que veio depois dele.
 * "10 minutos" não é resposta — o número precisa estar sozinho.
 * @returns {{ numero: '1'|'2'|'3', nota: string|null } | null}
 */
export function lerRespostaDoBriefing(texto) {
  const m = /^\s*([123])(?![0-9])\s*[-.:,)]?\s*([\s\S]*)$/.exec(String(texto ?? ''));
  if (!m) return null;
  return { numero: m[1], nota: m[2].trim() || null };
}

/** O que volta ao professor depois do 1/2/3. */
export function textoDaResposta({ numero, aluno, nivel = 'professor', repassadoA = null }) {
  if (numero === '1') return `Anotado: você assumiu o encaminhamento de ${aluno}.`;
  if (numero === '2') return `Anotado: o encaminhamento de ${aluno} está resolvido.`;
  if (nivel === 'professor' && repassadoA) return `Anotado: o encaminhamento de ${aluno} foi para ${repassadoA}.`;
  return `Anotado: o encaminhamento de ${aluno} fica na tela Acompanhamento do Prescrev.`;
}

export const SEM_ENCAMINHAMENTO = 'Não há encaminhamento aberto para você agora.';

const normalizarNome = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Quem recebe o encaminhamento de um aluno (D3, §7.1 do plano):
 *
 *   card        o professor escolhido no card do Prescrev
 *   treino_evo  quem prescreveu o treino vigente no EVO, casado pelo nome
 *               completo com um usuário do Prescrev
 *   avaliador   o avaliador da avaliação mais recente
 *
 * O número de WhatsApp é outra conta: quem não ativou o EQUIPE não tem, e o
 * encaminhamento vai ao coordenador.
 *
 * @returns {{ profile_id: string, nome: string, origem: string } | null}
 */
export function destinoDoAluno({ ficha, treinos = [], hoje, equipe = [] }) {
  const p = ficha?.professor;
  if (p?.origem === 'card') {
    const m = equipe.find(x => x.profile_id === p.profile_id);
    return { profile_id: p.profile_id, nome: m?.nome ?? primeiroNome(p.nome), origem: 'card' };
  }
  const vig = treinoVigente(treinos, hoje);
  if (vig?.professor) {
    const m = equipe.find(x => normalizarNome(x.nome_completo) === normalizarNome(vig.professor));
    if (m) return { profile_id: m.profile_id, nome: m.nome, origem: 'treino_evo' };
  }
  if (p) return { profile_id: p.profile_id, nome: primeiroNome(p.nome), origem: p.origem ?? 'avaliador' };
  return null;
}

/**
 * O coordenador de plantão: papel coordinator, EQUIPE ativado e horário que
 * serve — no horário agora antes de quem entra depois, e, empatados, quem
 * ativou primeiro. Nunca quem já recebeu.
 *
 * @param {object[]} ativos  linhas de acomp_equipe
 * @param {{ horarios: Map<string, object|null>, agora: Date, urgencia: string, exigirHoje?: boolean }} p
 * @returns {object|null} o coordenador, com `envio` ({ acao, enviarEm })
 */
export function coordenadorDePlantao(ativos, excetoPhone, { horarios, agora, urgencia, exigirHoje }) {
  return (ativos ?? [])
    .filter(a => a.papel === 'coordinator' && a.phone !== excetoPhone)
    .map(a => ({ ...a, envio: quandoEnviar({ horario: horarios.get(a.profile_id) ?? null, urgencia, agora, exigirHoje }) }))
    .filter(a => a.envio.acao !== 'indisponivel')
    .sort((a, b) => a.envio.enviarEm - b.envio.enviarEm || String(a.ativado_em).localeCompare(String(b.ativado_em)))[0] ?? null;
}

/**
 * Para quem vai um encaminhamento novo, e quando: o professor, se ativou o
 * EQUIPE e trabalha a tempo; senão, a coordenação de plantão; senão,
 * ninguém (fica na tela do Prescrev). As notas dizem por que não foi ao
 * professor — vão ao histórico.
 *
 * "A tempo": urgência "hoje" pede turno ainda hoje; o envio de teste não
 * pede, e espera o turno de quem vai testar.
 *
 * @returns {{ pessoa: object|null, nivel: 'professor'|'coordenacao', quando: object|null, notas: string[] }}
 */
export function rotear({ urgencia, origem, professorId, ativos, horarios, agora }) {
  const notas = [];
  const exigirHoje = urgencia === 'hoje' && origem !== 'teste';
  const prof = professorId ? (ativos ?? []).find(a => a.profile_id === professorId) : null;
  if (prof) {
    const quando = quandoEnviar({ horario: horarios.get(prof.profile_id) ?? null, urgencia, agora, exigirHoje });
    if (quando.acao !== 'indisponivel') return { pessoa: prof, nivel: 'professor', quando, notas };
    notas.push(`${prof.nome}: ${quando.motivo}`);
  } else {
    notas.push(professorId ? 'o professor ainda não ativou o EQUIPE' : 'aluno sem professor');
  }
  if (origem === 'teste') return { pessoa: null, nivel: 'professor', quando: null, notas };

  const coord = coordenadorDePlantao(ativos, prof?.phone ?? null, { horarios, agora, urgencia, exigirHoje });
  if (coord) return { pessoa: coord, nivel: 'coordenacao', quando: coord.envio, notas };
  // Urgente e ninguém trabalha mais hoje: vai ao professor, no próximo turno
  // dele — melhor do que ficar sem destino. Quem resolve o urgente na hora,
  // no sinal de alerta, é o atendimento médico que a Leia orienta.
  if (prof && exigirHoje) {
    const proximoTurno = quandoEnviar({ horario: horarios.get(prof.profile_id) ?? null, urgencia, agora, exigirHoje: false });
    if (proximoTurno.acao !== 'indisponivel') {
      notas.push('ninguém da coordenação trabalha mais hoje: vai ao professor no próximo turno');
      return { pessoa: prof, nivel: 'professor', quando: proximoTurno, notas };
    }
  }
  notas.push('nenhuma coordenação com EQUIPE ativado e horário que sirva');
  return { pessoa: null, nivel: 'professor', quando: null, notas };
}
