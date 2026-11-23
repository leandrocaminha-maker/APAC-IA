/**
 * src/routes/acompanhamento.js
 * As rotas de máquina do acompanhamento: quem chama é o Prescrev.
 *
 *   GET /acompanhamento/encaminhamentos?dias=30
 *       os encaminhamentos dos últimos dias e quem ativou o EQUIPE — a tela
 *       Acompanhamento do Prescrev filtra por quem está logado.
 *
 *   GET  /acompanhamento/inscricoes?cliente=<id>
 *       as inscrições (ATIVAR) — o número só pelo final — para o card
 *
 *   POST /acompanhamento/inscricoes/<id>/confirmar?por=<nome>
 *       a equipe confirma, no card, o número pendente (§5.1). O "por" vai na
 *       consulta, e não no corpo: é o caminho que se assina.
 *
 *   GET  /acompanhamento/numero
 *       o número de atendimento da academia (WHATSAPP_NUMERO_PRINCIPAL), para
 *       o QR code de ativação do Relatório 1: é para ele que o aluno manda
 *       "ATIVAR <código>". O número mora aqui, e o Prescrev não o copia.
 *
 *   GET  /acompanhamento/treinos?evo=<id do aluno no EVO>
 *       os treinos de musculação do aluno no EVO, resumidos por
 *       `resumirTreinos` (os mesmos que a régua lê), para o card do cliente
 *       no Prescrev comparar a validade com o ciclo prescrito. Lê o EVO na
 *       hora, um aluno por chamada.
 *
 *   GET  /acompanhamento/carteira-treinos
 *       os alunos ativos com treino de musculação no EVO (segmentação do CRM,
 *       migration 023) e o resumo dos treinos de cada um, lido uma vez por
 *       dia — o painel "Treinos no EVO" do Prescrev.
 *
 *   GET  /acompanhamento/grade?atividades=18,41,54
 *       a grade de sessões da agenda do EVO daquelas atividades, de segunda
 *       a sexta, nas próximas duas semanas (`aulasDaGrade`): os horários de
 *       encontro de meta do Prescrev (062 de lá) saem dela.
 *
 *   GET  /acompanhamento/encaminhamentos/<id>/conversa
 *       a conversa da ponte (A5d) daquele encaminhamento, sem números, com
 *       quem é o professor e o destinatário — o Prescrev confere se quem está
 *       logado pode ver antes de mostrar.
 *
 *   GET  /acompanhamento/historico?cliente=<id>&de=AAAA-MM-DD
 *       o que aconteceu com o aluno no WhatsApp desde aquele dia, para a aba
 *       de ciclos do Prescrev (069 de lá): as mensagens que a régua ENVIOU
 *       (dia e situação, sem o texto), os dias em que o aluno escreveu (só o
 *       dia, sem o conteúdo; null sem inscrição com contato) e os
 *       encaminhamentos dele. O formato atravessa os dois (`HistoricoDoApac`,
 *       ciclos-banco.ts): mudou um, mude o outro.
 *
 * Sem login: aceita só requisição assinada com `ACOMPANHAMENTO_SECRET`, o
 * mesmo esquema das rotas do Prescrev que o worker daqui chama
 * (HMAC-SHA256 hex de `${timestamp}.${caminho com a consulta}`, 5 minutos).
 * O encaminhamento traz nome do aluno e motivo: a assinatura é a única coisa
 * entre ele e a internet. Não afrouxe.
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { equipeAtivada, listarEncaminhamentos } from '../services/acompanhamento/encaminhamentos.js';
import { confirmar, listarInscricoes } from '../services/acompanhamento/ativacao.js';
import { conversaDoEncaminhamento } from '../services/acompanhamento/ponte.js';
import { resumirTreinos } from '../services/acompanhamento/regua.js';
import { buscarGrade, treinosDoAluno } from '../services/evo-client.js';
import { aulasDaGrade, proximosDias } from '../services/acompanhamento/grade-sessoes.js';
import { lerCarteira } from '../services/acompanhamento/carteira-treinos.js';

const JANELA_MS = 5 * 60_000;
const router = Router();

/** null = assinatura válida; senão, o motivo da recusa. */
export function conferirAssinatura(segredo, { assinatura, timestamp }, conteudo, agora = Date.now()) {
  if (!assinatura || !timestamp) return 'Requisição não assinada.';
  const idade = Math.abs(agora - Number(timestamp));
  if (!Number.isFinite(idade) || idade > JANELA_MS) return 'Assinatura fora da janela de validade.';
  const a = Buffer.from(String(assinatura), 'utf8');
  const b = Buffer.from(createHmac('sha256', segredo).update(`${timestamp}.${conteudo}`).digest('hex'), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'Assinatura inválida.';
  return null;
}

function assinado(req, res, next) {
  const segredo = config.acompanhamento.prescrev.segredo;
  if (!segredo) return res.status(503).json({ error: 'ACOMPANHAMENTO_SECRET não definido.' });
  const recusa = conferirAssinatura(segredo, {
    assinatura: req.get('x-prescrev-signature'),
    timestamp: req.get('x-prescrev-timestamp'),
  }, req.originalUrl);
  if (recusa) {
    logger.warn(`[acompanhamento] ${req.originalUrl} recusada: ${recusa}`);
    return res.status(401).json({ error: recusa });
  }
  next();
}

router.get('/encaminhamentos', assinado, async (req, res) => {
  try {
    const dias = Math.min(Math.max(parseInt(req.query.dias || '30', 10) || 30, 1), 90);
    const [encaminhamentos, ativos] = await Promise.all([listarEncaminhamentos({ dias }), equipeAtivada()]);
    res.json({
      encaminhamentos,
      // Sem o número: o Prescrev só precisa saber quem ativou.
      ativados: ativos.map(a => ({ profile_id: a.profile_id, nome: a.nome, papel: a.papel, ativado_em: a.ativado_em })),
    });
  } catch (err) {
    logger.error('[acompanhamento] Encaminhamentos ao Prescrev:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/encaminhamentos/:id/conversa', assinado, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { data: enc } = await supabase.from('acomp_encaminhamentos')
      .select('id, aluno, professor_profile_id, destinatario_profile_id').eq('id', id).maybeSingle();
    if (!enc) return res.status(404).json({ error: 'Encaminhamento não encontrado.' });
    res.json({ encaminhamento: enc, ...(await conversaDoEncaminhamento(id)) });
  } catch (err) {
    logger.error('[acompanhamento] Conversa da ponte ao Prescrev:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** O número como o wa.me o quer: só dígitos, com o 55 quando vem só com o DDD. Vazio sem número. */
export function numeroParaLink(numero) {
  const d = String(numero ?? '').replace(/\D/g, '');
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

router.get('/numero', assinado, (req, res) => {
  const numero = numeroParaLink(config.whatsapp.numeroPrincipal);
  if (!numero) return res.status(503).json({ error: 'WHATSAPP_NUMERO_PRINCIPAL não definido.' });
  res.json({ numero, exibicao: config.whatsapp.numeroPrincipal });
});

router.get('/treinos', assinado, async (req, res) => {
  const evo = Number(req.query.evo);
  if (!Number.isInteger(evo) || evo <= 0) return res.status(400).json({ error: 'evo precisa ser o id do aluno no EVO.' });
  try {
    res.json({ treinos: resumirTreinos(await treinosDoAluno(evo)) });
  } catch (err) {
    logger.error('[acompanhamento] Treinos ao Prescrev:', err.message);
    res.status(502).json({ error: `O EVO não respondeu: ${err.message}` });
  }
});

router.get('/carteira-treinos', assinado, async (req, res) => {
  try {
    res.json({ alunos: await lerCarteira() });
  } catch (err) {
    logger.error('[acompanhamento] Carteira de treinos ao Prescrev:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/grade', assinado, async (req, res) => {
  const atividades = String(req.query.atividades ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!atividades.length) return res.status(400).json({ error: 'atividades precisa ser a lista de ids do EVO.' });
  try {
    // A grade do dia vem em cache (buscarGrade): dias em sequência, para não pedir em rajada.
    const grades = [];
    for (const data of proximosDias(new Date(), 14)) grades.push({ data, aulas: await buscarGrade({ date: data }) });
    res.json({ aulas: aulasDaGrade(grades, atividades) });
  } catch (err) {
    logger.error('[acompanhamento] Grade ao Prescrev:', err.message);
    res.status(502).json({ error: `O EVO não respondeu: ${err.message}` });
  }
});

router.get('/historico', assinado, async (req, res) => {
  const cliente = String(req.query.cliente ?? '');
  const de = String(req.query.de ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(cliente)) return res.status(400).json({ error: 'cliente precisa ser o id do Prescrev.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(de)) return res.status(400).json({ error: 'de precisa ser AAAA-MM-DD.' });
  try {
    const desde = `${de}T00:00:00-03:00`;
    const diaSP = iso => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
    const [disparos, encaminhamentos, inscricoes] = await Promise.all([
      supabase.from('acomp_disparos').select('dia, situacao')
        .eq('cliente_id', cliente).eq('modo', 'envio').eq('status', 'enviado').gte('dia', de).order('dia').limit(1000),
      supabase.from('acomp_encaminhamentos').select('created_at, motivo, status, origem, destinatario_nome')
        .eq('cliente_id', cliente).gte('created_at', desde).order('created_at').limit(500),
      supabase.from('acomp_inscricoes').select('contact_id')
        .eq('cliente_id', cliente).not('contact_id', 'is', null).order('created_at', { ascending: false }).limit(5),
    ]);
    for (const [nome, r] of [['acomp_disparos', disparos], ['acomp_encaminhamentos', encaminhamentos], ['acomp_inscricoes', inscricoes]]) {
      if (r.error) throw new Error(`${nome}: ${r.error.message}`);
    }
    // Só o dia em que o aluno escreveu: o conteúdo da conversa não sai daqui.
    let respostas = null;
    const contatos = [...new Set((inscricoes.data ?? []).map(i => i.contact_id))];
    if (contatos.length) {
      const { data, error } = await supabase.from('wa_messages').select('created_at')
        .in('contact_id', contatos).eq('direction', 'inbound').gte('created_at', desde).order('created_at').limit(5000);
      if (error) throw new Error(`wa_messages: ${error.message}`);
      respostas = [...new Set((data ?? []).map(m => diaSP(m.created_at)))];
    }
    res.json({
      mensagens: (disparos.data ?? []).filter(d => d.situacao).map(d => ({ dia: d.dia, situacao: d.situacao })),
      respostas,
      encaminhamentos: encaminhamentos.data ?? [],
    });
  } catch (err) {
    logger.error('[acompanhamento] Histórico ao Prescrev:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/inscricoes', assinado, async (req, res) => {
  try {
    const clienteId = req.query.cliente ? String(req.query.cliente) : null;
    res.json({ inscricoes: await listarInscricoes({ clienteId }) });
  } catch (err) {
    logger.error('[acompanhamento] Inscrições ao Prescrev:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/inscricoes/:id/confirmar', assinado, async (req, res) => {
  try {
    await confirmar(String(req.params.id), String(req.query.por || 'Prescrev').slice(0, 80));
    res.json({ ok: true });
  } catch (err) {
    logger.warn('[acompanhamento] Confirmação de número:', err.message);
    res.status(400).json({ error: err.message });
  }
});

export default router;
