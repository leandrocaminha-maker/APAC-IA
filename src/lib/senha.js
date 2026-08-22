/**
 * src/lib/senha.js
 * Hash e conferência de senha — scrypt do `node:crypto`.
 *
 * Módulo próprio, e não parte de crm-auth.js, por um motivo prático: o
 * script `criar-consultor.js` precisa do hash e nada mais. Importá-lo de
 * crm-auth arrastava junto o cliente Supabase com transport WebSocket, e o
 * `process.exit` do script terminava em assertion do libuv no Windows.
 * Uma função de hash não tem por que depender de banco.
 *
 * Por que scrypt e não bcrypt: o projeto não tem dependência nativa
 * nenhuma, e acrescentar bcrypt traria compilação de binário ao build do
 * container. scrypt é KDF de memória-dura e está na biblioteca padrão.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const N = 16384;
const R = 8;
const P = 1;
const LEN = 32;

/**
 * Gera o hash de uma senha.
 *
 * Formato: `scrypt$N$r$p$salt$derivada` (salt e derivada em base64url).
 * Os parâmetros vão dentro do próprio hash para poderem ser endurecidos
 * no futuro sem migration nem invalidar as senhas já criadas.
 */
export async function hashSenha(senha) {
  const salt = randomBytes(16);
  const dk = await scrypt(String(senha), salt, LEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64url'), dk.toString('base64url')].join('$');
}

/** Confere a senha contra o hash guardado, em tempo constante. */
export async function conferirSenha(senha, hashGuardado) {
  try {
    const [algo, n, r, p, saltB64, dkB64] = String(hashGuardado).split('$');
    if (algo !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64url');
    const esperado = Buffer.from(dkB64, 'base64url');
    const obtido = await scrypt(String(senha), salt, esperado.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return obtido.length === esperado.length && timingSafeEqual(obtido, esperado);
  } catch {
    return false;
  }
}
