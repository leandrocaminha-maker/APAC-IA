import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerMensagem, textoDescrito, TIPOS_QUE_ABREM_TURNO } from './mensagem-regras.js';

const abreTurno = (m) => TIPOS_QUE_ABREM_TURNO.includes(lerMensagem(m)?.contentType);

test('texto, nos dois formatos', () => {
  assert.deepEqual(lerMensagem({ conversation: 'oi' }), { content: 'oi', contentType: 'text' });
  assert.deepEqual(lerMensagem({ extendedTextMessage: { text: 'quero natação' } }), { content: 'quero natação', contentType: 'text' });
});

test('reação tem nome e não abre turno da Leia; reação retirada some', () => {
  const r = lerMensagem({ reactionMessage: { key: { id: 'X' }, text: '❤️' } });
  assert.deepEqual(r, { content: '[reagiu com ❤️]', contentType: 'reaction' });
  assert.equal(abreTurno({ reactionMessage: { text: '👍' } }), false);
  assert.equal(lerMensagem({ reactionMessage: { key: { id: 'X' }, text: '' } }), null);
});

test('figurinha: parada dá para descrever, animada não', () => {
  assert.deepEqual(lerMensagem({ stickerMessage: { mimetype: 'image/webp', isAnimated: false, isLottie: false } }),
    { content: '[figurinha]', contentType: 'sticker', descritivel: true });
  assert.equal(lerMensagem({ stickerMessage: { mimetype: 'image/webp', isAnimated: true } }).descritivel, false);
  assert.equal(lerMensagem({ stickerMessage: { isLottie: true } }).descritivel, false);
  assert.equal(abreTurno({ stickerMessage: {} }), false);
});

test('imagem: com e sem legenda, e o formato que o modelo lê', () => {
  assert.deepEqual(lerMensagem({ imageMessage: { mimetype: 'image/jpeg' } }),
    { content: '[imagem]', contentType: 'image', legenda: '', descritivel: true });
  const comLegenda = lerMensagem({ imageMessage: { mimetype: 'image/jpeg', caption: 'segue o comprovante' } });
  assert.equal(comLegenda.content, 'segue o comprovante');
  assert.equal(comLegenda.legenda, 'segue o comprovante');
  assert.equal(lerMensagem({ imageMessage: { mimetype: 'image/heic' } }).descritivel, false);
});

test('GIF é o vídeo com gifPlayback; vídeo comum segue vídeo', () => {
  assert.deepEqual(lerMensagem({ videoMessage: { gifPlayback: true, mimetype: 'video/mp4' } }), { content: '[gif]', contentType: 'gif' });
  assert.deepEqual(lerMensagem({ videoMessage: { caption: 'olha o treino' } }), { content: 'olha o treino', contentType: 'video' });
});

test('contato, localização e enquete', () => {
  assert.deepEqual(lerMensagem({ contactMessage: { displayName: 'Miguel Filho', vcard: 'BEGIN:VCARD' } }),
    { content: '[contato] Miguel Filho', contentType: 'contact' });
  assert.equal(lerMensagem({ locationMessage: { degreesLatitude: -23.5, name: 'AP Academia' } }).content, '[localização] AP Academia');
  assert.equal(lerMensagem({ pollCreationMessageV3: { name: 'Qual horário?' } }).content, '[enquete] Qual horário?');
});

test('mensagem automática de empresa fica gravada com o texto, sem turno da Leia', () => {
  const modelo = lerMensagem({
    templateMessage: { hydratedTemplate: { hydratedTitleText: '', hydratedContentText: 'Ainda deseja prosseguir com nossa oferta?' } },
  });
  assert.equal(modelo.contentType, 'automated');
  assert.equal(modelo.content, '[mensagem automática de empresa] Ainda deseja prosseguir com nossa oferta?');
  assert.equal(lerMensagem({ listMessage: { title: 'Bem vindo', description: 'Selecione o time' } }).content,
    '[mensagem automática de empresa] Bem vindo\nSelecione o time');
  assert.equal(lerMensagem({ buttonsMessage: { contentText: 'Consegui te ajudar?' } }).contentType, 'automated');
  assert.equal(lerMensagem({ interactiveMessage: { body: { text: 'Facilite os pagamentos' } } }).contentType, 'automated');
  assert.equal(abreTurno({ buttonsMessage: { contentText: 'x' } }), false);
});

test('a RESPOSTA a botão ou lista (o toque da pessoa) continua sendo texto', () => {
  assert.deepEqual(lerMensagem({ buttonsResponseMessage: { selectedDisplayText: 'Sim' } }), { content: 'Sim', contentType: 'text' });
  assert.deepEqual(lerMensagem({ listResponseMessage: { title: 'Natação' } }), { content: 'Natação', contentType: 'text' });
});

test('o que não é mensagem não é gravado', () => {
  assert.equal(lerMensagem({ protocolMessage: { type: 14, editedMessage: { conversation: 'corrigido' } } }), null);
  assert.equal(lerMensagem({ secretEncryptedMessage: { encPayload: 'abc', secretEncType: 2 } }), null);
  assert.equal(lerMensagem({ pinInChatMessage: { type: 1 } }), null);
  assert.equal(lerMensagem({ pollUpdateMessage: {} }), null);
  assert.equal(lerMensagem({ albumMessage: { expectedImageCount: 3 } }), null);
});

test('a foto de um álbum vem embrulhada e é lida como imagem', () => {
  const foto = lerMensagem({
    messageContextInfo: {},
    associatedChildMessage: { message: { imageMessage: { mimetype: 'image/jpeg', caption: '' } } },
  });
  assert.equal(foto.contentType, 'image');
  assert.equal(foto.descritivel, true);
});

test('documento com legenda e mensagem temporária são desembrulhados', () => {
  assert.equal(lerMensagem({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'atestado.pdf' } } } }).content, 'atestado.pdf');
  assert.deepEqual(lerMensagem({ ephemeralMessage: { message: { conversation: 'oi' } } }), { content: 'oi', contentType: 'text' });
});

test('o que ainda não se conhece segue como antes, para aparecer', () => {
  assert.deepEqual(lerMensagem({ algumaCoisaNova: {} }), { content: '[mensagem não suportada]', contentType: 'unknown' });
  assert.equal(abreTurno({ algumaCoisaNova: {} }), true);
});

test('o texto gravado depois da descrição', () => {
  assert.equal(textoDescrito({ contentType: 'image', descricao: 'Comprovante de PIX de R$ 199,00\npara AP Academia.' }),
    '[imagem] Comprovante de PIX de R$ 199,00 para AP Academia.');
  assert.equal(textoDescrito({ contentType: 'image', descricao: 'Comprovante de PIX.', legenda: 'segue' }), 'segue\n[imagem] Comprovante de PIX.');
  assert.equal(textoDescrito({ contentType: 'sticker', descricao: 'Gato fazendo joinha.' }), '[figurinha] Gato fazendo joinha.');
});
