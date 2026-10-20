import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.ts';

export function validPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new HttpError(400, 'Password must be 10–128 characters.');
}
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key));
});
export async function passwordHash(password: string) {
  validPassword(password);
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
export async function matches(password: string, hash: string) {
  const [version, salt, expected] = hash.split(':');
  if (version !== 'scrypt-v1' || !salt || !expected) return false;
  const actual = await derive(password, salt);
  const bytes = Buffer.from(expected, 'hex');
  return actual.length === bytes.length && timingSafeEqual(actual, bytes);
}
