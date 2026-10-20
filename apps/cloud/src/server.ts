import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import pg from 'pg';
import { migrate } from './database.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key));
});
async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
async function matches(password: string, hash: string) {
  const [version, salt, expected] = hash.split(':');
  if (version !== 'scrypt-v1' || !salt || !expected) return false;
  const actual = await derive(password, salt);
  const bytes = Buffer.from(expected, 'hex');
  return actual.length === bytes.length && timingSafeEqual(actual, bytes);
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function credentials(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send JSON credentials.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
  const username = typeof body?.username === 'string' ? body.username.normalize('NFKC').trim().toLowerCase() : '';
  const password = body?.password;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{2,31}$/u.test(username)) throw new HttpError(400, 'Username must be 3–32 letters, numbers, underscores or hyphens.');
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new HttpError(400, 'Password must be 10–128 characters.');
  return { username, password };
}
type Account = { id: string; username: string; password_hash: string; quota_bytes: string; disabled: boolean };

export async function startCloud({ databaseUrl, port = 8080, host = '127.0.0.1' }: { databaseUrl: string; port?: number; host?: string }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000 });
  // pg discards failed idle clients. Keep serving so requests can reconnect after a database restart.
  pool.on('error', () => console.error('Cloud database connection interrupted; waiting for reconnection.'));
  try { await migrate(pool); } catch (error) { await pool.end(); throw error; }
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
    await pool.query("INSERT INTO cloud_sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')", [digest(token), user.id]);
    return { token, user: { id: user.id, username: user.username } };
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
            'INSERT INTO cloud_users(id, username, password_hash) VALUES ($1, $2, $3) ON CONFLICT(username) DO NOTHING RETURNING *', [randomUUID(), username, hash]);
          if (!result.rows[0]) throw new HttpError(409, 'That username is already registered.');
          return json(res, 201, await session(result.rows[0]));
        }
        const user = (await pool.query<Account>('SELECT * FROM cloud_users WHERE username = $1', [username])).rows[0];
        const valid = await matches(password, user?.password_hash ?? dummyPassword);
        if (!valid || !user || user.disabled) throw new HttpError(401, 'Username or password is incorrect.');
        return json(res, 200, await session(user));
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
      return json(res, 200, { ownerId: user.id, quotaBytes: Number(user.quota_bytes), usedBytes: 0, reservedBytes: 0 });
    }
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
  return {
    origin: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await pool.end();
    },
  };
}
