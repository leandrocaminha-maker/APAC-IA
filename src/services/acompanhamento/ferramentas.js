/**
 * src/services/acompanhamento/ferramentas.js
 * As ferramentas da Leia no caminho `acompanhamento` (§6.4 do plano).
 *
 * A lista é FIXA e em ordem estável: as tools vêm antes do system no prefixo
 * do cache, e uma lista que mudasse de turno para turno invalidaria o cache
 * da conversa. `transferir_para_humano` é a mesma declaração do atendimento
 * de vendas.
 *
 * ## Só a simulação, nesta etapa
 *
 * A A3 é a Leia no simulador do painel. A execução aqui REGISTRA o que a
 * ferramenta faria — no turno e na tela —, e não escreve em lugar nenhum: o
 * encaminhamento não abre (sairia com o nome de um aluno de verdade na tela do
 * Prescrev, por um teste), e a pausa não grava. O efeito real entra com a
 * ativação do aluno, na A5, junto com a porta do webhook.
 */
import { toolDeclarations } from '../ai-tools.js';

const transferir = toolDeclarations.find(t => t.name === 'transferir_para_humano');

export const CATEGORIAS = ['dor_ou_lesao', 'saude', 'ajuste_de_treino', 'ausencia_ou_desanimo', 'pedido_do_aluno', 'outro'];
export const DESFECHOS = ['reforco', 'informacao', 'encaminhamento', 'pausa', 'consultor', 'outro'];

export const FERRAMENTAS = [
  {
    name: 'registrar_desfecho',
    description: 'Registra o modo deste turno. Chame em TODO turno, junto com a resposta ao aluno.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tipo: { type: 'string', enum: DESFECHOS },
        resumo: {
          type: 'string',
          description: 'Uma linha: o que o aluno trouxe e o que você fez. Até 200 caracteres. É lido pela equipe, não pelo aluno.',
        },
      },
      required: ['tipo', 'resumo'],
    },
  },
  {
    name: 'encaminhar_ao_professor',
    description: 'Avisa o professor do aluno pelo WhatsApp dele, para que ele fale com o aluno. Use para dor, lesão, sintoma, ' +
      'remédio, pedido de mudar o treino, desânimo, faltas seguidas, dúvida de execução, pedido do professor — e na terceira ' +
      'troca. Um por motivo: se o contexto diz que já foi encaminhado pelo mesmo motivo, não chame de novo. Escreva a ' +
      'resposta ao aluno normalmente, no mesmo turno.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        categoria: { type: 'string', enum: CATEGORIAS },
        urgencia: {
          type: 'string',
          enum: ['hoje', 'proximos_dias'],
          description: '"hoje" para sinal de alerta, dor forte ou nova, ou o que não pode esperar; senão "proximos_dias".',
        },
        resumo_para_professor: {
          type: 'string',
          description: 'O que o aluno disse, com as palavras dele quando importar, e o que você respondeu. Até 400 caracteres. ' +
            'Sem hipótese de diagnóstico.',
        },
      },
      required: ['categoria', 'urgencia', 'resumo_para_professor'],
    },
  },
  {
    name: 'pausar_acompanhamento',
    description: 'Pausa as mensagens do acompanhamento para este aluno — viagem, um tempo sem vir. Não suspende o ' +
      'contrato: suspensão de plano é com o consultor.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ate: { type: 'string', description: 'AAAA-MM-DD, até quando — só se ele disse. Vazio se não disse.' },
        motivo: { type: 'string', description: 'Uma linha.' },
      },
      required: ['motivo'],
    },
  },
  transferir,
];

/**
 * O executor da simulação: registra em `turno` o que cada ferramenta faria.
 * @param {{ desfecho: object|null, encaminhamentos: object[], pausa: object|null, handoff: object|null }} turno
 */
export function executorDeSimulacao(turno) {
  return async (nome, args) => {
    switch (nome) {
      case 'registrar_desfecho':
        if (!DESFECHOS.includes(args.tipo)) return { success: false, mensagem: `tipo inválido: ${args.tipo}` };
        turno.desfecho = { tipo: args.tipo, resumo: String(args.resumo ?? '').slice(0, 200) };
        return { success: true };
      case 'encaminhar_ao_professor':
        if (!CATEGORIAS.includes(args.categoria)) return { success: false, mensagem: `categoria inválida: ${args.categoria}` };
        turno.encaminhamentos.push({
          categoria: args.categoria, urgencia: args.urgencia === 'hoje' ? 'hoje' : 'proximos_dias',
          resumo: String(args.resumo_para_professor ?? '').slice(0, 400),
        });
        return { success: true, simulado: true, mensagem: 'Encaminhamento registrado. O professor fala com o aluno.' };
      case 'pausar_acompanhamento':
        turno.pausa = { ate: args.ate || null, motivo: String(args.motivo ?? '') };
        return { success: true, simulado: true };
      case 'transferir_para_humano':
        turno.handoff = { motivo: args.motivo, mensagem: args.mensagem };
        return { success: true, action: 'handoff', motivo: args.motivo, mensagem: args.mensagem };
      default:
        return { success: false, mensagem: `Ferramenta "${nome}" não existe neste caminho.` };
    }
  };
}
