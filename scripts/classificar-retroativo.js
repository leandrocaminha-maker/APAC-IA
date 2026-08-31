/**
 * Classificação retroativa: quem já está no funil é aluno ou é lead?
 *
 * A ramificação (migrations 009/010) nasceu com todo mundo em `lead`, que é
 * o que todo mundo era antes de existirem duas trilhas. A classificação de
 * verdade acontece conversa a conversa — a Leia marca, o consultor
 * corrige. Este script adianta a parte que **não depende de ninguém
 * perceber nada**: quem tem contrato ativo no EVO é aluno, ponto.
 *
 * É a mesma pergunta que a varredura de follow-up faz no fim do laço
 * (`situacaoComercial`), e é dela que o script se serve — de propósito.
 * Uma segunda definição de "aluno" no mesmo sistema seria a forma mais
 * rápida de as duas discordarem.
 *
 * ## O que ele NÃO faz
 *
 * Não adivinha convênio, fornecedor nem engano. Nada no EVO responde isso,
 * e chutar aqui gravaria erro permanente no contato — que é o que decide a
 * trilha de todos os atendimentos seguintes daquele número. Esses três
 * vêm da conversa, pela tool da Leia ou pelo painel.
 *
 * Não mexe em atendimento encerrado nem em linha com experimental marcada:
 * quem cuida disso é `definirTipoDeContato`, e o motivo está lá.
 *
 * ## Custo
 *
 * Uma a duas chamadas ao EVO por lead, e o cliente do EVO respeita a cota
 * de 5 por segundo. Com ~230 leads abertos, são poucos minutos.
 *
 * Uso:
 *   npm run classificar -- --dry        # só mostra o que faria
 *   npm run classificar                 # grava
 *   npm run classificar -- --limite=50  # em lotes
 */
import 'dotenv/config';
import { supabase } from '../src/lib/supabase.js';
import { funil } from '../src/services/funil.js';
import { followup } from '../src/services/followup.js';
import { telefoneValido } from '../src/services/evolution.js';

const args = process.argv.slice(2);
const simulacao = args.includes('--dry');
const arg = (nome, padrao) => {
  const achado = args.find(a => a.startsWith(`--${nome}=`));
  return achado ? achado.split('=').slice(1).join('=') : padrao;
};
const limite = parseInt(arg('limite', '500'), 10);

const { data: leads, error } = await supabase
  .from('crm_leads')
  .select('id, full_name, phone, stage, contact_id, evo_id_member, trilha, tipo_contato')
  .eq('trilha', 'lead')
  .not('stage', 'in', funil.FILTRO_ETAPAS_FECHADAS)
  .not('phone', 'is', null)
  .order('id', { ascending: true })
  .limit(limite);

if (error) {
  console.error('Falha ao ler o funil:', error.message);
  process.exit(1);
}

console.log(
  `\n${leads.length} atendimento(s) abertos na trilha de venda` +
  (simulacao ? ' — SIMULAÇÃO, nada será gravado\n' : '\n')
);

const resumo = { aluno: 0, lead: 0, indefinido: 0, pulados: 0, erros: 0 };
const alunos = [];

for (const lead of leads) {
  // Lixo de cadastro não vale uma chamada ao EVO.
  if (String(lead.phone).startsWith('teste') || !telefoneValido(lead.phone)) {
    resumo.pulados++;
    continue;
  }

  let situacao;
  try {
    situacao = await followup.situacaoComercial(lead);
  } catch (err) {
    console.log(`  ! lead ${lead.id}: ${err.message}`);
    resumo.erros++;
    continue;
  }

  resumo[situacao] = (resumo[situacao] || 0) + 1;
  if (situacao !== 'aluno') continue;

  const nome = String(lead.full_name || 'sem nome').slice(0, 30).padEnd(30);
  alunos.push(lead.id);
  console.log(`  ${String(lead.id).padStart(4)} | ${nome} | ${lead.stage}`);

  if (simulacao) continue;

  try {
    const r = await funil.definirTipoDeContato(lead, 'aluno', {
      actor: 'sistema',
      motivo: 'contrato ativo no EVO (classificação retroativa)',
    });
    if (r?.aviso) console.log(`         ↳ ${r.aviso}`);
  } catch (err) {
    console.log(`         ↳ falhou: ${err.message}`);
    resumo.erros++;
  }
}

console.log(
  `\n${simulacao ? 'Entrariam' : 'Classificados'} como aluno: ${alunos.length}\n` +
  `Seguem como lead: ${resumo.lead}\n` +
  `EVO não respondeu (ficam como estão): ${resumo.indefinido}\n` +
  `Telefone inutilizável, sem chamada ao EVO: ${resumo.pulados}\n` +
  `Erros: ${resumo.erros}\n`
);

if (simulacao) console.log('Nada foi gravado. Rode sem --dry para valer.\n');

process.exit(0);
