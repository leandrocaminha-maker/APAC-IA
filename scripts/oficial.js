/**
 * scripts/oficial.js
 * Linha de comando do ENSAIO da API oficial do WhatsApp (Cloud API).
 *
 * Só precisa de `WA_OFICIAL_TOKEN` e `WA_OFICIAL_PHONE_ID` no `.env`, e roda
 * de qualquer máquina: o envio não passa pelo backend nem pela Evolution.
 * O que CHEGA (resposta da pessoa, entregue, lida, preço) aparece no log do
 * backend, nas linhas `[oficial]`, depois de o webhook estar apontado.
 *
 * Uso:
 *
 *   npm run oficial -- status
 *       Como a Meta vê o número: nome de exibição, qualidade, limite.
 *
 *   npm run oficial -- modelo <telefone> [nome] [idioma] [campo1 campo2 …]
 *       Abre conversa com um modelo. Sem nome, o `hello_world` (en_US), que
 *       todo número de teste tem. Os campos são {{1}}, {{2}}… do corpo.
 *
 *   npm run oficial -- texto <telefone> <texto…>
 *       Texto livre. A Meta só aceita se a pessoa escreveu ao número nas
 *       últimas 24 h; fora disso volta o erro 131047 — que é parte do ensaio.
 *
 *   npm run oficial -- modelos
 *       Os modelos da conta, com estado e categoria (pede WA_OFICIAL_WABA_ID).
 *
 *   npm run oficial -- registrar <PIN de 6 dígitos>
 *       Registra na Cloud API um número de verdade, já adicionado e
 *       verificado na conta. O PIN vira o da verificação em duas etapas.
 *
 *   npm run oficial -- assinar
 *       Liga os avisos da conta ao app (pede WA_OFICIAL_WABA_ID). Só é
 *       preciso em conta nova; a de teste já vem ligada.
 *
 * Com o número de teste da Meta, o telefone tem de estar na lista de
 * destinatários da tela "Configuração da API" (até 5).
 */
import { whatsappOficial } from '../src/services/whatsapp-oficial.js';

const [comando = 'status', ...args] = process.argv.slice(2);

async function status() {
  const n = await whatsappOficial.infoDoNumero();
  console.log(`Número:            ${n.display_phone_number ?? '—'}`);
  console.log(`Nome de exibição:  ${n.verified_name ?? '—'} (${n.name_status ?? '—'})`);
  console.log(`Qualidade:         ${n.quality_rating ?? '—'}`);
  console.log(`Limite:            ${n.messaging_limit_tier ?? '—'}`);
  console.log(`Verificação:       ${n.code_verification_status ?? '—'}`);
}

async function modelo() {
  const [telefone, nome = 'hello_world', idioma = 'en_US', ...campos] = args;
  if (!telefone) throw new Error('uso: modelo <telefone> [nome] [idioma] [campos…]');
  const r = await whatsappOficial.enviarModelo(telefone, nome, idioma, campos);
  console.log(`Aceito pela Meta. id ${r.id}, destinatário ${r.waId}`);
  console.log('Aceito não é entregue: o "delivered" e o preço chegam pelo webhook.');
}

async function texto() {
  const [telefone, ...palavras] = args;
  if (!telefone || !palavras.length) throw new Error('uso: texto <telefone> <texto…>');
  const r = await whatsappOficial.enviarTexto(telefone, palavras.join(' '));
  console.log(`Aceito pela Meta. id ${r.id}, destinatário ${r.waId}`);
}

async function modelos() {
  const lista = await whatsappOficial.listarModelos();
  if (!lista.length) return console.log('Nenhum modelo na conta.');
  for (const m of lista) console.log(`${m.status.padEnd(10)} ${m.category.padEnd(14)} ${m.language.padEnd(6)} ${m.name}`);
}

async function registrar() {
  await whatsappOficial.registrarNumero(args[0]);
  console.log('Número registrado na Cloud API. Guarde o PIN: ele é exigido para desfazer.');
}

async function assinar() {
  await whatsappOficial.assinarAvisos();
  console.log('Avisos da conta ligados ao app: o webhook passa a receber deste número.');
}

const comandos = { status, modelo, texto, modelos, registrar, assinar };

if (!comandos[comando]) {
  console.error(`Comando desconhecido: "${comando}". Use status, modelo, texto, modelos, registrar ou assinar.`);
  process.exit(1);
}

// `exitCode`, e não `exit()`: sair com a conexão do fetch ainda fechando
// derruba o Node no Windows com uma falha de asserção.
comandos[comando]().catch(err => {
  console.error(`Falhou: ${err.message}`);
  if (err.codigo === 131047) console.error('→ Fora da janela de 24 h: a pessoa precisa escrever ao número, ou use um modelo.');
  if (err.codigo === 131030) console.error('→ O telefone não está na lista de destinatários do número de teste.');
  if (err.codigo === 190) console.error('→ Token vencido ou inválido: gere outro na tela "Configuração da API".');
  process.exitCode = 1;
});
