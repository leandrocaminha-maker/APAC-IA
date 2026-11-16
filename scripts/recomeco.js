/**
 * scripts/recomeco.js
 * Linha de comando do recomeço depois de uma restrição da Meta.
 *
 * O backend grava a queda e a volta sozinho (`src/services/recomeco.js`).
 * Isto existe para ver em que dia da rampa o número está e para corrigir à
 * mão o que a máquina não tem como saber: que a queda não foi restrição, ou
 * que houve uma restrição que ela não viu.
 *
 * Uso (na VPS: `docker compose exec backend npm run recomeco -- <comando>`):
 *
 *   node scripts/recomeco.js status
 *       A restrição gravada, o dia da rampa e a cota de hoje.
 *
 *   node scripts/recomeco.js marcar [quando]
 *       Grava uma restrição. `quando` em ISO (2026-11-16T20:57:31Z); sem
 *       ele, agora. O teto fica em zero até a volta.
 *
 *   node scripts/recomeco.js voltou [quando]
 *       Grava a volta do número, de onde a rampa é contada. Só é preciso se
 *       o backend não viu a sessão reconectar.
 *
 *   node scripts/recomeco.js encerrar
 *       Encerra o recomeço: volta a valer o teto de regime. É o que se usa
 *       quando o aparelho foi tirado pelo celular e não houve restrição.
 *
 * O backend relê o marcador a cada minuto: o comando vale sem restart.
 */
import { config } from '../src/config.js';
import { recomeco } from '../src/services/recomeco.js';
import { limiteEnvio } from '../src/services/limite-envio.js';

const [comando = 'status', argumento] = process.argv.slice(2);

const emSP = (iso) => iso
  ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })
  : '—';

function instante(texto) {
  if (!texto) return new Date();
  const d = new Date(texto);
  if (Number.isNaN(d.getTime())) {
    console.error(`Não entendi a data "${texto}". Use ISO, como 2026-11-16T20:57:31Z.`);
    process.exit(1);
  }
  return d;
}

async function status() {
  const rampa = config.envio.recomecoRampa;
  const s = await recomeco.situacao();

  console.log(`Rampa (ENVIO_RECOMECO_RAMPA): ${rampa.length ? rampa.join(', ') : 'desligada'}`);
  console.log(`Teto de regime (ENVIO_TETO_DIARIO): ${config.envio.tetoDiario || 'desligado'}`);

  if (s.indisponivel) {
    console.log(`\n⚠️  ${s.motivo}`);
    return;
  }

  const r = s.restricao;
  if (!r) {
    console.log('\nNenhuma restrição gravada.');
  } else {
    console.log(`\nRestrição gravada: ${emSP(r.em)} (código ${r.codigo ?? '?'})`);
    console.log(`Volta do número:   ${emSP(r.voltou_em)}`);
    if (r.encerrado_em) console.log(`Encerrada à mão:   ${emSP(r.encerrado_em)}`);
  }

  console.log(`\nRecomeço: ${s.ativo ? s.motivo : 'não está em recomeço'}`);

  const cota = await limiteEnvio.cota();
  console.log(cota.restante === Infinity
    ? 'Cota de hoje: sem teto'
    : `Cota de hoje: ${cota.usados ?? 0} de ${cota.teto} — ${cota.ok ? `restam ${cota.restante}` : cota.motivo}`);
}

switch (comando) {
  case 'status':
    await status();
    break;

  case 'marcar': {
    const gravou = await recomeco.registrarQueda({ em: instante(argumento), codigo: 401 });
    console.log(gravou
      ? 'Restrição gravada. A máquina não inicia conversa até a volta do número.'
      : 'Nada gravado: já há uma queda gravada nessa hora ou depois dela (ou o banco não respondeu).');
    await status();
    break;
  }

  case 'voltou': {
    const gravou = await recomeco.registrarVolta(instante(argumento));
    console.log(gravou
      ? 'Volta gravada. A rampa conta deste dia.'
      : 'Nada gravado: não há restrição esperando a volta.');
    await status();
    break;
  }

  case 'encerrar': {
    const gravou = await recomeco.encerrar();
    console.log(gravou
      ? 'Recomeço encerrado: vale o teto de regime.'
      : 'Nada a encerrar: não há restrição em aberto.');
    await status();
    break;
  }

  default:
    console.error(`Comando desconhecido: "${comando}". Use status, marcar, voltou ou encerrar.`);
    process.exit(1);
}

process.exit(0);
