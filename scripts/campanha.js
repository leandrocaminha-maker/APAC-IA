/**
 * scripts/campanha.js
 * Linha de comando da campanha ativa.
 *
 * Existe porque a Fase 1 não tem tela: o piloto precisa ser conduzido e
 * medido por alguém antes de virar botão no painel. Também é o único jeito
 * de olhar a coorte **sem criar campanha nenhuma**, que é como todo piloto
 * deveria começar.
 *
 * Uso:
 *   node scripts/campanha.js segmentos
 *       Lista os segmentos disponíveis.
 *
 *   node scripts/campanha.js espiar <segmento> [--limite=50]
 *       Monta a coorte e mostra tamanho + amostra. NÃO grava nada.
 *
 *   node scripts/campanha.js criar <slug> --segmento=<nome> --oferta="..."
 *                                  [--titulo="..."] [--teto=20] [--roteiro="..."]
 *                                  [--base-legal="..."] [--args='{"mesesMax":24}']
 *       Cria a campanha em rascunho.
 *
 *   node scripts/campanha.js alvos <slug>
 *       Monta a coorte e grava os alvos. Idempotente.
 *
 *   node scripts/campanha.js ativar <slug>   |   pausar <slug> [motivo]
 *
 *   node scripts/campanha.js rodar <slug>
 *       Roda UM ciclo agora, sem esperar o worker. Respeita CAMPANHA_DRY_RUN.
 *
 *   node scripts/campanha.js status [slug]
 *       Resumo: alvos, enviados, respostas, supressões, taxas.
 *
 *   node scripts/campanha.js reset <slug>
 *       Devolve à fila os alvos gerados em ENSAIO (queue_id nulo). Não toca
 *       em quem já foi enfileirado de verdade.
 *
 *   node scripts/campanha.js suprimir <telefone> [motivo]
 *   node scripts/campanha.js supressoes
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { NOMES_SEGMENTOS, montarSegmento } from '../src/services/segmentos.js';
import {
  buscarCampanha, montarAlvos, processarCampanha, resumo, suprimir,
} from '../src/services/campanhas.js';
import { aiAgent } from '../src/services/ai-agent.js';
import { supabase } from '../src/lib/supabase.js';

const [, , comando, ...resto] = process.argv;

/** --chave=valor → { chave: valor } */
function opcoes(args) {
  const o = {};
  for (const a of args) {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    if (m) o[m[1]] = m[2] === '' ? true : m[2];
  }
  return o;
}

/** Argumentos posicionais (o que não começa com --). */
const posicionais = resto.filter(a => !a.startsWith('--'));
const opts = opcoes(resto);

function sair(msg, codigo = 1) {
  console.error(msg);
  process.exit(codigo);
}

async function exigirCampanha(slug) {
  if (!slug) sair('Falta o slug da campanha.');
  const c = await buscarCampanha(slug);
  if (!c) sair(`Campanha "${slug}" não existe. Veja com: node scripts/campanha.js status`);
  return c;
}

const comandos = {
  async segmentos() {
    console.log('Segmentos disponíveis:\n');
    for (const nome of NOMES_SEGMENTOS) console.log(`  ${nome}`);
    console.log('\nPara ver quem cai em cada um, sem gravar nada:');
    console.log('  node scripts/campanha.js espiar ex_aluno_reativavel');
  },

  async espiar() {
    const [nome] = posicionais;
    if (!nome) sair(`Falta o segmento. Disponíveis: ${NOMES_SEGMENTOS.join(', ')}`);

    const args = opts.args ? JSON.parse(opts.args) : {};
    if (opts.limite) args.limite = Number(opts.limite);

    console.log(`Montando "${nome}" — isto consulta o EVO e pode demorar.\n`);
    const lista = await montarSegmento(nome, args);

    console.log(`\n${lista.length} pessoa(s) na coorte.\n`);
    if (!lista.length) return;

    console.log('Amostra de até 10 (telefone mascarado):');
    for (const p of lista.slice(0, 10)) {
      const mascarado = p.phone.slice(0, 6) + '****' + p.phone.slice(-2);
      console.log(`  ${mascarado}  ${(p.nome || '(sem nome)').padEnd(14)} ${JSON.stringify(p.contexto)}`);
    }
    console.log('\nNada foi gravado. Para criar a campanha, use: criar');
  },

  async criar() {
    const [slug] = posicionais;
    if (!slug) sair('Falta o slug. Ex.: node scripts/campanha.js criar volta-2026 --segmento=... --oferta="..."');
    if (!opts.segmento) sair(`Falta --segmento. Disponíveis: ${NOMES_SEGMENTOS.join(', ')}`);
    if (!NOMES_SEGMENTOS.includes(opts.segmento)) {
      sair(`Segmento "${opts.segmento}" não existe. Disponíveis: ${NOMES_SEGMENTOS.join(', ')}`);
    }
    if (!opts.oferta) {
      sair(
        'Falta --oferta.\n\n' +
        'A oferta é o ÚNICO fato que a mensagem pode afirmar — o modelo não\n' +
        'carrega a base de conhecimento neste caminho, então preço, prazo e\n' +
        'condição só existem se estiverem escritos aqui, por você.'
      );
    }

    const { data, error } = await supabase
      .from('crm_campanhas')
      .insert({
        slug,
        titulo: opts.titulo || slug,
        segmento: opts.segmento,
        segmento_args: opts.args ? JSON.parse(opts.args) : {},
        oferta: opts.oferta,
        roteiro: opts.roteiro || null,
        teto_diario: opts.teto ? Number(opts.teto) : 20,
        base_legal: opts['base-legal'] || null,
        criada_por: 'cli',
        status: 'rascunho',
      })
      .select()
      .single();

    if (error) sair(`Não criou: ${error.message}`);

    console.log(`Campanha "${data.slug}" criada em rascunho (id ${data.id}).`);
    console.log(`  segmento ....... ${data.segmento} ${JSON.stringify(data.segmento_args)}`);
    console.log(`  teto diário .... ${data.teto_diario}`);
    console.log('\nPróximo passo:  node scripts/campanha.js alvos ' + data.slug);
  },

  async alvos() {
    const campanha = await exigirCampanha(posicionais[0]);
    console.log(`Montando alvos de "${campanha.slug}" — consulta o EVO, pode demorar.\n`);
    const r = await montarAlvos(campanha.id);
    console.log(`  na coorte ............ ${r.total}`);
    console.log(`  já suprimidos ........ ${r.suprimidos}`);
    console.log(`  já eram alvos ........ ${r.jaExistiam}`);
    console.log(`  novos alvos gravados . ${r.inseridos}`);
    console.log('\nPróximo passo:  node scripts/campanha.js ativar ' + campanha.slug);
  },

  async ativar() {
    const campanha = await exigirCampanha(posicionais[0]);
    await supabase
      .from('crm_campanhas')
      .update({ status: 'ativa', pausada_motivo: null })
      .eq('id', campanha.id);

    console.log(`Campanha "${campanha.slug}" ATIVA (teto de ${campanha.teto_diario}/dia).`);
    if (config.campanha.dryRun) {
      console.log('\n⚠️  CAMPANHA_DRY_RUN=true: o worker vai GERAR os textos mas não enviar nada.');
      console.log('    Leia o que sairia com: node scripts/campanha.js status ' + campanha.slug);
    } else if (!config.campanha.habilitada) {
      console.log('\n⚠️  CAMPANHA_HABILITADA=false: o worker nem inicia. Nada vai sair.');
    } else {
      console.log('\n⚠️  As mensagens VÃO SAIR para clientes reais dentro da janela de contato (9h–20h30 em dia útil, 9h–13h no sábado, nunca no domingo).');
    }
  },

  async pausar() {
    const campanha = await exigirCampanha(posicionais[0]);
    const motivo = posicionais[1] || 'pausada manualmente';
    await supabase
      .from('crm_campanhas')
      .update({ status: 'pausada', pausada_motivo: motivo })
      .eq('id', campanha.id);
    console.log(`Campanha "${campanha.slug}" pausada: ${motivo}`);
  },

  async rodar() {
    const campanha = await exigirCampanha(posicionais[0]);
    if (campanha.status !== 'ativa') {
      sair(`Campanha "${campanha.slug}" está "${campanha.status}" — ative antes.`);
    }

    console.log(
      `Rodando um ciclo de "${campanha.slug}"` +
      `${config.campanha.dryRun ? ' em ENSAIO (nada será enviado)' : ' — MENSAGENS VÃO SAIR'}\n`
    );

    const r = await processarCampanha(campanha, async (alvo, c) => {
      const { text } = await aiAgent.gerarMensagemCampanha({
        alvo, oferta: c.oferta, roteiro: c.roteiro,
      });
      return text;
    });

    console.log(`\n${r.agendados} agendada(s)${r.motivo ? ` — ${r.motivo}` : ''}`);
  },

  async status() {
    const linhas = await resumo(posicionais[0] || null);
    if (!linhas.length) return console.log('Nenhuma campanha.');

    for (const c of linhas) {
      console.log(`\n── ${c.slug} — ${c.titulo}`);
      console.log(`   ${c.status}${c.pausada_motivo ? ` (${c.pausada_motivo})` : ''} · ${c.tipo} · teto ${c.teto_diario}/dia`);
      console.log(`   alvos ${c.alvos} · pendentes ${c.pendentes} · agendados ${c.agendados} · enviados ${c.enviados}`);
      console.log(`   responderam ${c.responderam} · suprimidos ${c.suprimidos} · erros ${c.erros} · hoje ${c.enviados_hoje}`);
      console.log(`   taxa de resposta ${c.taxa_resposta ?? '—'} · taxa de supressão ${c.taxa_supressao ?? '—'} (limiar ${c.limiar_supressao})`);
    }

    // Em ensaio o texto gerado é o produto: é o que se lê antes de liberar.
    if (posicionais[0]) {
      const campanha = await buscarCampanha(posicionais[0]);
      const { data: exemplos } = await supabase
        .from('crm_campanha_alvos')
        .select('nome, mensagem, scheduled_for, status')
        .eq('campanha_id', campanha.id)
        .not('mensagem', 'is', null)
        .order('scheduled_for', { ascending: true })
        .limit(5);

      if (exemplos?.length) {
        console.log('\n── Mensagens geradas (5 primeiras)');
        for (const e of exemplos) {
          console.log(`\n   [${e.status}] ${e.scheduled_for} · ${e.nome || '(sem nome)'}`);
          console.log('   ' + e.mensagem.split('\n').join('\n   '));
        }
      }
    }
  },

  async reset() {
    const campanha = await exigirCampanha(posicionais[0]);

    // Só o que foi gerado em ENSAIO volta para a fila. Ensaio grava
    // 'agendado' com `queue_id` nulo — é justamente esse nulo que separa o
    // que nunca chegou à fila do que foi enfileirado de verdade. Sem esse
    // filtro, um reset descuidado remandaria mensagem para quem já recebeu.
    const { data, error } = await supabase
      .from('crm_campanha_alvos')
      .update({ status: 'pendente', mensagem: null, scheduled_for: null })
      .eq('campanha_id', campanha.id)
      .eq('status', 'agendado')
      .is('queue_id', null)
      .select('id');

    if (error) sair(`Não resetou: ${error.message}`);
    console.log(`${data?.length ?? 0} alvo(s) de ensaio voltaram para "pendente".`);
    console.log('Quem já foi enfileirado ou enviado de verdade NÃO foi tocado.');
  },

  async suprimir() {
    const [telefone, motivo] = posicionais;
    if (!telefone) sair('Falta o telefone.');
    const r = await suprimir(telefone, { motivo: motivo || 'manual', origem: 'painel' });
    console.log(
      `${telefone} suprimido${r.novo ? '' : ' (já estava na lista)'}` +
      `${r.canceladas ? ` — ${r.canceladas} agendada(s) cancelada(s)` : ''}`
    );
  },

  async supressoes() {
    const { data } = await supabase
      .from('crm_supressoes')
      .select('phone, motivo, origem, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (!data?.length) return console.log('Nenhuma supressão registrada.');
    console.log(`${data.length} supressão(ões), mais recentes primeiro:\n`);
    for (const s of data) {
      console.log(`  ${s.phone}  ${s.motivo.padEnd(18)} ${s.origem || '—'}  ${s.created_at.slice(0, 16)}`);
    }
  },
};

if (!comando || !comandos[comando]) {
  console.log(`Comandos: ${Object.keys(comandos).join(', ')}`);
  console.log('\nDetalhe de uso no cabeçalho de scripts/campanha.js');
  process.exit(comando ? 1 : 0);
}

try {
  await comandos[comando]();
} catch (err) {
  sair(`\nFalhou: ${err.message}`);
}
