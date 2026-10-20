import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { HttpError, json, readJson } from './http.ts';
import { passwordHash, matches, validPassword } from './password.ts';
import pg from 'pg';
import { migrate } from './database.ts';
import { createLibrary, defaultLimits, type Limits } from './library.ts';
import { storageFromEnv, type StorageConfig } from './storage.ts';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
async function credentials(req: IncomingMessage) {
  const body = await readJson(req, 4096);
  const username = typeof body?.username === 'string' ? body.username.normalize('NFKC').trim().toLowerCase() : '';
  const password = body?.password;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{2,31}$/u.test(username)) throw new HttpError(400, 'Username must be 3–32 letters, numbers, underscores or hyphens.');
  validPassword(password);
  return { username, password };
}
type Account = { id: string; username: string; password_hash: string; quota_bytes: string; disabled: boolean };

export async function startCloud({ databaseUrl, port = 8080, host = '127.0.0.1', storage = storageFromEnv(), limits: overrides = {} }: { databaseUrl: string; port?: number; host?: string; storage?: StorageConfig; limits?: Partial<Limits> }) {
  const limits = { ...defaultLimits, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Cloud limits must be positive integers.');
  if (limits.partBytes < 102400 || limits.partBytes > 64 * 1024 * 1024) throw new Error('Choose a part size from 100 KiB to 64 MiB allowing at most 10000 parts per file.');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000 });
  // pg discards failed idle clients. Keep serving so requests can reconnect after a database restart.
  pool.on('error', () => console.error('Cloud database connection interrupted; waiting for reconnection.'));
  try { await migrate(pool); } catch (error) { await pool.end(); throw error; }
  const library = createLibrary(pool, storage, limits);
  const dummyPassword = await passwordHash(randomBytes(24).toString('hex'));
  // Bound password work and per-peer attempts. Forwarded IP headers are untrusted.
  const attempts = new Map<string, { count: number; until: number }>();
  let authenticating = 0;
  function admit(req: IncomingMessage) {
    const now = Date.now();
    for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!attempts.has(ip) && attempts.size >= 10_000) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    const entry = attempts.get(ip) ?? { count: 0, until: now + 60_000 };
    entry.count += 1;
    attempts.set(ip, entry);
    if (entry.count > 30 || authenticating >= 4) throw new HttpError(429, 'Too many sign-in attempts. Try again in a minute.');
  }
  async function session(user: Account) {
    const token = randomBytes(32).toString('hex');
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const current=(await client.query<Account>('SELECT * FROM cloud_users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
      if(!current || current.disabled || current.password_hash!==user.password_hash)throw new HttpError(401,'Account changed. Sign in again.');
      await client.query("INSERT INTO cloud_sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')", [digest(token), user.id]);
      await client.query('COMMIT');
      return { token, user: { id: user.id, username: user.username } };
    } catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async function account(req: IncomingMessage): Promise<Account> {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new HttpError(401, 'Sign in to OpenFilm Cloud.');
    const result = await pool.query<Account>(
      'SELECT u.* FROM cloud_users u JOIN cloud_sessions s ON s.user_id = u.id WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled', [digest(token)]);
    if (!result.rows[0]) throw new HttpError(401, 'Your cloud session has expired. Sign in again.');
    return result.rows[0];
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health' && req.method === 'GET') {
      await pool.query('SELECT 1');
      return json(res, 200, { service: 'openfilm-cloud', status: 'ready' });
    }
    if (req.method === 'POST' && (path === '/v1/auth/register' || path === '/v1/auth/login')) {
      admit(req);
      authenticating += 1;
      try {
        const { username, password } = await credentials(req);
        if (path.endsWith('/register')) {
          const hash = await passwordHash(password);
          const result = await pool.query<Account>(
            'INSERT INTO cloud_users(id, username, password_hash, quota_bytes) VALUES ($1, $2, $3, $4) ON CONFLICT(username) DO NOTHING RETURNING *', [randomUUID(), username, hash, limits.quotaBytes]);
          if (!result.rows[0]) throw new HttpError(409, 'That username is already registered.');
          return json(res, 201, await session(result.rows[0]));
        }
        const user = (await pool.query<Account>('SELECT * FROM cloud_users WHERE username = $1', [username])).rows[0];
        const valid = await matches(password, user?.password_hash ?? dummyPassword);
        if (!valid || !user || user.disabled) throw new HttpError(401, 'Username or password is incorrect.');
        return json(res, 200, await session(user));
      } finally { authenticating -= 1; }
    }
    if (path === '/v1/auth/password' && req.method === 'POST') {
      admit(req);
      authenticating += 1;
      try {
      const user = await account(req);
      const body = await readJson(req, 4096);
      validPassword(body.newPassword);
      if (typeof body.oldPassword !== 'string' || body.oldPassword.length > 128 || !await matches(body.oldPassword, user.password_hash)) throw new HttpError(403, 'Current password is incorrect.');
      const hash = await passwordHash(body.newPassword);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const changed = await client.query('UPDATE cloud_users SET password_hash = $1 WHERE id = $2 AND password_hash = $3 AND NOT disabled RETURNING id', [hash, user.id, user.password_hash]);
        if (!changed.rowCount) throw new HttpError(409, 'The account changed. Sign in again.');
        await client.query('DELETE FROM cloud_sessions WHERE user_id = $1', [user.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      return json(res, 200, { signedOut: true });
      } finally { authenticating -= 1; }
    }
    if (path === '/v1/me' && req.method === 'GET') {
      const user = await account(req);
      return json(res, 200, { id: user.id, username: user.username });
    }
    if (path === '/v1/auth/logout' && req.method === 'POST') {
      await account(req);
      await pool.query('DELETE FROM cloud_sessions WHERE token_hash = $1', [digest(req.headers.authorization!.slice(7))]);
      return json(res, 200, { signedOut: true });
    }
    if (path === '/v1/space' && req.method === 'GET') {
      const user = await account(req);
      return json(res, 200, { ...await library.space(user), limits: { fileBytes: limits.fileBytes, snapshotBytes: limits.snapshotBytes, partBytes: limits.partBytes } });
    }
    if (/^\/v1\/(items|uploads)(\/|$)/.test(path)) return library.route(req, res, await account(req));
    throw new HttpError(404, 'Not found.');
  }
  const server = createServer((req, res) => {
    void route(req, res).catch(error => {
      if (error instanceof HttpError && error.status === 429) res.setHeader('retry-after', '60');
      if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'Cloud service could not complete the request.' });
      else res.destroy();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) { await pool.end(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cloud service did not bind a TCP port.');
  let cleaning: Promise<void> | undefined;
  const sweep = setInterval(() => { if (!cleaning) cleaning = library.cleanup().catch(() => {}).finally(() => { cleaning=undefined; }); }, limits.cleanupSeconds * 1000).unref();
  return {
    origin: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    async close() {
      clearInterval(sweep);
      await cleaning;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.end();
    },
  };
}
