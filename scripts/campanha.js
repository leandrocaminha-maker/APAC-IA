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
 *
 * Pesquisa de satisfação, pelo número alternativo (migration 019):
 *
 *   node scripts/campanha.js criar-pesquisa <slug> --link=https://...
 *                                  --gatilho="[CODIGO] descrição do segmento no EVO"
 *                                  [--link-espera=resposta|<minutos>] [--teto=80]
 *                                  [--titulo="..."] [--base-legal="..."]
 *                                  [--abertura-arquivo=abertura.txt] [--link-arquivo=link.txt]
 *       Cria a pesquisa em rascunho. Sem os arquivos, valem os textos padrão
 *       de src/services/pesquisa-regras.js. --link-espera diz o que acontece
 *       com quem NÃO responde à abertura: "resposta" (o padrão) = não recebe
 *       o link; um número = recebe depois desses minutos.
 *
 *   node scripts/campanha.js alvo <slug> <telefone> [nome]
 *       Põe UMA pessoa na campanha, à mão. É como se faz o piloto com os
 *       celulares da equipe antes de o segmento do EVO entrar.
 *
 *   node scripts/campanha.js gatilhos [--dias=30]
 *       As descrições de segmento que o EVO mandou, e a campanha que cada
 *       uma achou. "NENHUMA" é coorte descartada sem ninguém ver.
 *
 *   node scripts/campanha.js reabsorver <slug> [--dias=30]
 *       Repassa à campanha os eventos de segmentação já recebidos — para a
 *       coorte que chegou antes de a campanha existir. Não reenvia nada do EVO.
 *
 *   node scripts/campanha.js numero
 *       O número alternativo: sessão, dia da rampa, teto de hoje e fila.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { NOMES_SEGMENTOS, montarSegmento } from '../src/services/segmentos.js';
import {
  absorverSegmentacao, buscarCampanha, campanhaDoGatilho, codigoDoSegmento,
  montarAlvos, processarCampanha, resumo, suprimir,
} from '../src/services/campanhas.js';
import { aiAgent } from '../src/services/ai-agent.js';
import { supabase } from '../src/lib/supabase.js';
import { telefoneValido } from '../src/services/evolution.js';
import { limiteEnvio } from '../src/services/limite-envio.js';
import { numeroAlternativo } from '../src/services/numero-alternativo.js';
import {
  ABERTURA_PADRAO, LINK_PADRAO, PREFIXO_ALT, PREFIXO_LINK, TETO_MAXIMO,
  ehPesquisa, problemasDosModelos, textoDeAbertura, textoDoLink, variantes,
} from '../src/services/pesquisa-regras.js';

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

/** Texto de um arquivo, ou null quando a opção não veio. */
function lerArquivo(caminho) {
  if (!caminho || caminho === true) return null;
  try {
    return readFileSync(caminho, 'utf8');
  } catch (err) {
    sair(`Não li "${caminho}": ${err.message}`);
  }
}

/**
 * Os eventos de segmentação que o EVO mandou nos últimos `dias`, do mais
 * novo para o mais velho. Em páginas: o Supabase corta a resposta em 1000.
 */
async function eventosDeSegmentacao(dias) {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const eventos = [];

  for (let pagina = 0; pagina < 10; pagina++) {
    const { data, error } = await supabase
      .from('crm_evo_webhook_events')
      .select('id, created_at, payload')
      .like('event_type', 'crm.segmentation%')
      .gte('created_at', desde)
      .order('created_at', { ascending: false })
      .range(pagina * 1000, pagina * 1000 + 999);

    if (error) sair(`Não li os eventos do EVO: ${error.message}`);
    eventos.push(...data);
    if (data.length < 1000) break;
  }
  return eventos;
}

const descricaoDe = (evento) => evento.payload?.communication?.message?.trim() || null;

/** A descrição é do gatilho desta campanha? A mesma regra de `campanhaDoGatilho`. */
function ehDoGatilho(descricao, gatilho) {
  if (!descricao || !gatilho) return false;
  if (descricao === gatilho) return true;
  const codigo = codigoDoSegmento(gatilho);
  return Boolean(codigo) && codigoDoSegmento(descricao) === codigo;
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

    if (ehPesquisa(campanha)) {
      const cota = await limiteEnvio.cotaAlternativo();
      const estado = await numeroAlternativo.estadoDaConexao({ maxIdadeMs: 0 });
      console.log('\nÉ pesquisa: sai pelo número alternativo, não pelo de atendimento.');
      console.log(`  sessão do número alternativo ... ${estado === 'open' ? 'conectada' : `"${estado}" — NADA sai enquanto não parear`}`);
      console.log(`  teto de hoje ................... ${cota.usados == null ? cota.motivo : `${cota.teto} (dia ${cota.dia + 1} de uso; já saíram ${cota.usados})`}`);
    }

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
      if (c.finalidade === 'pesquisa') {
        console.log(`   pesquisa · com o link ${c.links_enviados} · sem resposta à abertura ${c.sem_resposta} · recusaram ${c.recusaram}`);
      }
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

  // ── Pesquisa de satisfação, pelo número alternativo ────────────────────

  async 'criar-pesquisa'() {
    const [slug] = posicionais;
    if (!slug) {
      sair('Falta o slug. Ex.: node scripts/campanha.js criar-pesquisa satisfacao-2026 ' +
        '--link=https://... --gatilho="[PESQ-2026] alunos adultos ativos"');
    }
    if (!opts.link || opts.link === true) sair('Falta --link=https://... (o endereço da pesquisa).');

    let linkEsperaMin = null;
    const espera = opts['link-espera'];
    if (espera && espera !== 'resposta') {
      linkEsperaMin = Number(espera);
      if (!Number.isInteger(linkEsperaMin) || linkEsperaMin < 1) {
        sair('--link-espera é "resposta" (só recebe o link quem responder) ou um número de minutos.');
      }
    }

    const abertura = lerArquivo(opts['abertura-arquivo']) ?? ABERTURA_PADRAO;
    const mensagemLink = lerArquivo(opts['link-arquivo']) ?? LINK_PADRAO;

    const problemas = problemasDosModelos({
      mensagem_abertura: abertura, mensagem_link: mensagemLink, link: opts.link,
    });
    if (problemas.length) sair(`Os textos não passaram:\n${problemas.map(p => `  - ${p}`).join('\n')}`);

    const { data, error } = await supabase
      .from('crm_campanhas')
      .insert({
        slug,
        titulo: opts.titulo || slug,
        finalidade: 'pesquisa',
        // `segmento` e `oferta` são obrigatórios na tabela e não têm papel
        // aqui: o público vem do EVO, e não há oferta.
        segmento: 'evo_segmentacao',
        oferta: 'Pesquisa de satisfação — não há oferta.',
        evento_gatilho: opts.gatilho && opts.gatilho !== true ? opts.gatilho.trim() : null,
        // Os textos ficam GRAVADOS na campanha, mesmo quando são os padrão:
        // é o registro do que saiu, e não muda se o código mudar depois.
        mensagem_abertura: abertura,
        mensagem_link: mensagemLink,
        link: opts.link,
        link_espera_min: linkEsperaMin,
        teto_diario: opts.teto ? Number(opts.teto) : Math.min(config.envioAlt.tetoDiario, TETO_MAXIMO),
        // Número novo: a guarda de supressão olha mais cedo que os 30 da venda.
        minimo_para_avaliar: 20,
        base_legal: opts['base-legal'] && opts['base-legal'] !== true ? opts['base-legal'] : null,
        criada_por: 'cli',
        status: 'rascunho',
      })
      .select()
      .single();

    if (error) {
      sair(`Não criou: ${error.message}` +
        (/finalidade|mensagem_abertura|link/.test(error.message)
          ? '\n\nParece a migration 019 por aplicar: rode supabase/migrations/019_pesquisa_numero_alternativo.sql no SQL Editor.'
          : ''));
    }

    const exemplo = { id: 0, nome: 'Maria' };
    const numeroPrincipal = config.whatsapp.numeroPrincipal;

    console.log(`Pesquisa "${data.slug}" criada em rascunho (id ${data.id}).`);
    console.log(`  sai por ........ número alternativo (${numeroAlternativo.instancia() ?? 'EVOLUTION_INSTANCE_ALT NÃO definido'})`);
    console.log(`  teto diário .... ${data.teto_diario} (o do número, com a rampa, vale por cima)`);
    console.log(`  gatilho do EVO . ${data.evento_gatilho ?? '— (sem gatilho: o segmento do EVO não vai achar esta campanha)'}`);
    console.log(`  link ........... ${data.link}`);
    console.log(`  sem resposta ... ${linkEsperaMin == null ? 'não recebe o link' : `recebe o link ${linkEsperaMin} min depois da abertura`}`);
    console.log(`  redações ....... ${variantes(abertura).length} de abertura, ${variantes(mensagemLink).length} de link`);
    if (!data.base_legal) {
      console.log('\n⚠️  base_legal ficou vazia. É o campo que diz, na LGPD, por que se pode falar com esta lista —');
      console.log('    preencha com --base-legal="..." ao criar, ou direto na tabela.');
    }
    if (!codigoDoSegmento(data.evento_gatilho)) {
      console.log('\n⚠️  O gatilho não começa com um código entre colchetes. Sem ele, a descrição do segmento');
      console.log('    no EVO tem de ser IDÊNTICA a este texto, letra por letra. Com "[PESQ-2026] ...", basta o código.');
    }

    console.log('\n── Como chega para uma "Maria" (1ª redação)\n');
    console.log(textoDeAbertura(exemplo, data, { numeroPrincipal }));
    console.log('\n   … ela responde, e então:\n');
    console.log(textoDoLink(exemplo, data, { numeroPrincipal }));

    console.log('\nPróximo passo: o piloto, com os celulares da equipe.');
    console.log(`  node scripts/campanha.js alvo ${data.slug} 11999998888 "Fulano"`);
    console.log(`  node scripts/campanha.js ativar ${data.slug}`);
  },

  async alvo() {
    const campanha = await exigirCampanha(posicionais[0]);
    const phone = telefoneValido(posicionais[1]);
    if (!phone) sair(`"${posicionais[1] ?? ''}" não é um celular utilizável (DDD + 9 dígitos).`);

    const { data, error } = await supabase
      .from('crm_campanha_alvos')
      .upsert({
        campanha_id: campanha.id,
        phone,
        nome: posicionais[2]?.trim().split(/\s+/)[0] || null,
        contexto: { origem: 'manual', recebido_em: new Date().toISOString() },
        status: 'pendente',
      }, { onConflict: 'campanha_id,phone', ignoreDuplicates: true })
      .select('id');

    if (error) sair(`Não gravou: ${error.message}`);
    console.log(data?.length
      ? `${phone} entrou em "${campanha.slug}" como pendente.`
      : `${phone} já era alvo de "${campanha.slug}" — nada mudou.`);
  },

  async gatilhos() {
    const dias = Number(opts.dias) || 30;
    const eventos = await eventosDeSegmentacao(dias);
    if (!eventos.length) return console.log(`Nenhum evento de segmentação do EVO nos últimos ${dias} dias.`);

    const porDescricao = new Map();
    for (const e of eventos) {
      const descricao = descricaoDe(e) ?? '(sem descrição)';
      const linha = porDescricao.get(descricao) ?? { pessoas: 0, ultimo: e.created_at };
      linha.pessoas++;
      porDescricao.set(descricao, linha);
    }

    console.log(`Segmentos que o EVO mandou nos últimos ${dias} dias:\n`);
    for (const [descricao, { pessoas, ultimo }] of porDescricao) {
      const campanha = descricao === '(sem descrição)' ? null : await campanhaDoGatilho(descricao);
      console.log(`  ${String(pessoas).padStart(4)} pessoa(s) · último em ${ultimo.slice(0, 16)}`);
      console.log(`       "${descricao}"`);
      console.log(`       → ${campanha ? `campanha "${campanha.slug}" (${campanha.status})` : 'NENHUMA campanha — a coorte foi descartada'}\n`);
    }
    console.log('Coorte descartada se recupera com: reabsorver <slug> (depois de acertar o gatilho da campanha).');
  },

  async reabsorver() {
    const campanha = await exigirCampanha(posicionais[0]);
    if (!campanha.evento_gatilho) sair(`"${campanha.slug}" não tem evento_gatilho — não há como saber quais eventos são dela.`);

    const dias = Number(opts.dias) || 30;
    const eventos = (await eventosDeSegmentacao(dias))
      .filter(e => ehDoGatilho(descricaoDe(e), campanha.evento_gatilho));

    if (!eventos.length) {
      sair(`Nenhum evento dos últimos ${dias} dias casa com o gatilho de "${campanha.slug}".\n` +
        'Veja o que chegou com: node scripts/campanha.js gatilhos', 0);
    }

    console.log(`${eventos.length} evento(s) do gatilho de "${campanha.slug}". Repassando…\n`);
    const contagem = new Map();
    for (const e of eventos.reverse()) {
      const r = await absorverSegmentacao(e.payload);
      const chave = r.ok ? (r.alvoId ? 'novo alvo' : 'já era alvo') : r.motivo.replace(/\(.*?\)/g, '').trim();
      contagem.set(chave, (contagem.get(chave) ?? 0) + 1);
    }
    for (const [motivo, n] of contagem) console.log(`  ${String(n).padStart(4)}  ${motivo}`);
  },

  async numero() {
    if (!numeroAlternativo.configurado()) {
      return console.log('Não há número alternativo: EVOLUTION_INSTANCE_ALT está vazio no .env.');
    }

    const estado = await numeroAlternativo.estadoDaConexao({ maxIdadeMs: 0 });
    const cota = await limiteEnvio.cotaAlternativo();
    const { tetoDiario, rampa, intervaloMinimoMin, espacamentoSeg } = config.envioAlt;

    const pendentes = async (prefixo) => (await supabase
      .from('wa_message_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
      .like('source_app', `${prefixo}%`)).count ?? 0;
    const naFila = await pendentes(PREFIXO_ALT);
    const links = await pendentes(PREFIXO_LINK);

    console.log(`Número alternativo — instância "${numeroAlternativo.instancia()}"`);
    console.log(`  sessão ......... ${estado === 'open' ? 'conectada' : `"${estado}" — nada sai (parear em Ajustes → WhatsApp — número alternativo)`}`);
    console.log(`  regulagem ...... teto ${Math.min(tetoDiario, TETO_MAXIMO)}/dia, rampa ${rampa.join(' → ') || 'desligada'}, ` +
      `≥ ${intervaloMinimoMin} min entre aberturas no agendamento, ~${espacamentoSeg}s entre envios`);
    if (cota.usados == null) {
      console.log(`  hoje ........... ${cota.motivo}`);
    } else {
      console.log(`  hoje ........... dia ${cota.dia + 1} de uso · ${cota.usados} de ${cota.teto} aberturas · restam ${cota.restante}`);
    }
    console.log(`  na fila ........ ${naFila - links} abertura(s) e ${links} link(s) por sair`);
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
