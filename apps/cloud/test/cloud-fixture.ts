import { createHash } from 'node:crypto';
import { testDatabase } from './database.ts';
import { ossServer } from './oss-server.ts';
import { startCloud } from '../src/server.ts';
import type { Limits } from '../src/library.ts';
export const database = { skip: !process.env.OPENFILM_TEST_DATABASE_URL };
export function fileMetadata(bytes: Buffer, extra: Record<string, any> = {}) {
  return { kind: 'asset', name: 'picture.png', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), md5: createHash('md5').update(bytes).digest('base64'), ...extra };
}
export async function cloudFixture(limits: Partial<Limits> = {}) {
  const db = await testDatabase(), oss = await ossServer();
  let cloud = await startCloud({ databaseUrl: db.url, port: 0, storage: oss.config, limits });
  const ask = (path: string, token?: string, body?: object) => fetch(`${cloud.origin}/v1/${path}`, {
    method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const register = async (username: string) => (await ask('auth/register', undefined, { username, password: `${username}-password-long` })).json();
  return {
    db, oss, get cloud() { return cloud; }, ask, register,
    async upload(token: string, bytes: Buffer, extra: Record<string, any> = {}) {
      const response = await ask('uploads', token, fileMetadata(bytes, extra));
      if (!response.ok) throw new Error(await response.text());
      const t = await response.json();
      const grant = await (await ask(`uploads/${t.id}/sign`, token, {})).json();
      const put = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: new Uint8Array(bytes) });
      if (!put.ok) throw new Error(await put.text());
      const done = await ask(`uploads/${t.id}/complete`, token, {});
      if (!done.ok) throw new Error(await done.text());
      return (await done.json()).item;
    },
    async restart() {
      const port = Number(new URL(cloud.origin).port);
      await cloud.close(); cloud = await startCloud({ databaseUrl: db.url, port, storage: oss.config, limits });
    },
    async close() { await cloud.close(); await oss.close(); await db.close(); },
  };
}
