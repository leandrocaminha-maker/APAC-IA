// Confirma a stanza <status> no Baileys 7.0.0-rc.9 da Evolution 2.3.7.
//
// O WhatsApp passou a entregar o status (story) dos contatos como uma stanza
// <status> de primeiro nível, e não mais como <message from="status@broadcast">.
// O rc.9 só registra tratador para message, call, receipt e notification: a
// <status> nunca é confirmada. O servidor segura tudo o que viria depois
// (mensagens recebidas, acks das enviadas) e, 50 minutos após a conexão,
// derruba o stream com
//   <stream:error><ack class="status" type="media" id="..."/></stream:error>
// Na reconexão entrega o que segurou, numa rajada, e manda outra <status>.
// O ciclo não termina, e parear de novo não resolve.
//
// A correção é a mesma do PR upstream (WhiskeySockets/Baileys#2866, issue
// #2858; evolution-api#2778): confirmar toda <status> com um ack simples,
// sem código de erro. O sendMessageAck do rc.9 já monta o ack certo:
//   <ack id=... to=<from> class="status" type=<type> [participant]/>
// O conteúdo do status não é lido, e a Evolution já o ignora (readStatus=false).
//
// Roda no build da imagem (docker/evolution/Dockerfile). Falha o build se
// qualquer premissa não bater: assim uma troca de imagem base não passa calada.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = process.argv[2] || '/evolution/node_modules/baileys';
const arquivo = path.join(dir, 'lib/Socket/messages-recv.js');
const VERSAO = '7.0.0-rc.9';
const MARCA = "ws.on('CB:status'";
const ANCORA = "    ws.on('CB:ack,class:message', (node) => {\n";
const TRECHO = [
  '    // [APAC] Confirma a stanza <status>; sem isto o servidor derruba o stream',
  '    // a cada 50 min (Baileys#2858). Ver docker/evolution/patch-status-ack.cjs.',
  "    ws.on('CB:status', (node) => {",
  "        sendMessageAck(node).catch(error => onUnexpectedError(error, 'acking status stanza'));",
  '    });',
  '',
].join('\n');

function falha(msg) {
  console.error('[patch-status-ack] FALHOU: ' + msg);
  process.exit(1);
}

const versao = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
if (versao !== VERSAO) {
  falha(`Baileys ${versao}, o patch foi escrito para ${VERSAO}. ` +
    'Confira se a versão nova já trata CB:status e, se tratar, remova o patch.');
}

const fonte = fs.readFileSync(arquivo, 'utf8');
if (fonte.includes(MARCA)) falha('o arquivo já tem tratador de CB:status');
const ocorrencias = fonte.split(ANCORA).length - 1;
if (ocorrencias !== 1) falha(`âncora encontrada ${ocorrencias} vezes, esperado 1`);
for (const nome of ['const sendMessageAck = async', 'onUnexpectedError']) {
  if (!fonte.includes(nome)) falha(`não achei ${nome} no arquivo`);
}

fs.writeFileSync(arquivo, fonte.replace(ANCORA, TRECHO + ANCORA));

const check = spawnSync(process.execPath, ['--check', arquivo], { encoding: 'utf8' });
if (check.status !== 0) {
  fs.writeFileSync(arquivo, fonte);
  falha('o arquivo alterado não passa no node --check:\n' + check.stderr);
}

console.log(`[patch-status-ack] aplicado em ${arquivo} (Baileys ${versao})`);
