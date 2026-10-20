// @ts-check
/** The cloud account belongs to this Studio home, never a film. Only this local process holds its token. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { studioHome } from './projects.mjs';
import { createCloudTransfers } from './cloud-transfers.mjs';
import { HttpError, json, readJson } from './http.mjs';

/** @typedef {{ serviceUrl: string | null, token?: string }} Account */

function serviceUrl(/** @type {unknown} */ value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'Enter your cloud service URL.');
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Enter a valid cloud service URL.'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new HttpError(400, 'Use HTTPS, or HTTP on localhost for development.');
  if (url.username || url.password || url.search || url.hash) throw new HttpError(400, 'The service URL cannot contain credentials, a query or a fragment.');
  return url.href.replace(/\/+$/, '');
}

export function createCloudAccount() {
  const home = studioHome(), file = join(home, 'cloud-account.json');
  /** @type {Account} */
  let state = { serviceUrl: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    state = { serviceUrl: serviceUrl(raw.serviceUrl),
      ...(typeof raw.token === 'string' && /^[a-f0-9]{64}$/.test(raw.token) ? { token: raw.token } : {}) };
  } catch { /* First use, or an invalid saved account: stay signed out. */ }
  const transfers = createCloudTransfers(connection);
  function save(/** @type {Account} */ next) {
    mkdirSync(home, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
    state = next;
    void transfers.stopAll();
  }
  async function request(/** @type {Account} */ current, /** @type {string} */ path, /** @type {unknown} */ body = undefined) {
    if (!current.serviceUrl) throw new HttpError(400, 'Configure your cloud service first.');
    let response;
    try {
      response = await fetch(`${current.serviceUrl}/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(current.token ? { authorization: `Bearer ${current.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new HttpError(503, 'Cloud service is unavailable. Your local projects are still available.'); }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      // A cloud 401 must not lock Studio's independent local session.
      throw new HttpError(response.status === 401 ? 403 : response.status, String(result?.error ?? 'Cloud request failed.'), { cloud: true });
    }
    if (!result || typeof result !== 'object') throw new HttpError(502, 'The cloud service returned an invalid response.');
    return result;
  }
  async function connection() {
    const current=state;
    if(!current.token)throw new HttpError(403,'Sign in to your cloud account.');
    const user=await request(current,'me');
    const assertCurrent=()=>{if(current!==state)throw new HttpError(403,'Cloud account changed. Resume after signing in to the original account.');};
    assertCurrent();
    return {serviceUrl:current.serviceUrl,ownerId:user.id,assertCurrent,async request(/** @type {string} */ path,/** @type {unknown} */ body=undefined){assertCurrent();const result=await request(current,path,body);assertCurrent();return result;}};
  }
  async function status() {
    const current = state;
    const base = { serviceUrl: current.serviceUrl, user: null, space: null, offline: false, hasSession: Boolean(current.token) };
    if (!current.token) return base;
    try {
      const [user, space] = await Promise.all([request(current, 'me'), request(current, 'space')]);
      if (current !== state) return status();
      return { ...base, user, space };
    } catch (error) {
      if (current !== state) return status();
      if (error instanceof HttpError && error.status === 403) {
        save({ serviceUrl: current.serviceUrl });
        return { ...base, hasSession: false, notice: 'Your cloud session ended. Sign in again.' };
      }
      return { ...base, offline: true, notice: 'Cloud service is unavailable. Your local projects are still available.' };
    }
  }
  /** Clear locally before waiting for the old service, so failure never keeps the old identity active here. */
  async function signOut() {
    const previous = state;
    save({ serviceUrl: previous.serviceUrl });
    if (!previous.token) return null;
    try { await request(previous, 'auth/logout', {}); return null; }
    catch (error) {
      if (error instanceof HttpError && error.status === 403) return null;
      return 'Signed out on this device. The cloud service could not be reached to revoke the remote session.';
    }
  }
  // Configuration and login changes are ordered, including requests from multiple editor tabs and the CLI.
  let changes = Promise.resolve();
  function change(/** @type {() => Promise<unknown>} */ action) {
    const result = changes.then(action);
    changes = result.then(() => {}, () => {});
    return result;
  }
  /** @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {string[]} parts */
  async function cloudRoute(req, res, parts) {
    if (['items','transfers'].includes(parts[1])) return transfers.route(req,res,parts);
    if (parts.length === 1 && req.method === 'GET') return json(res, 200, await status());
    if (parts.length !== 2 || req.method !== 'POST') throw new HttpError(404, 'Cloud operation not found.');
    const body = await readJson(req, 4096);
    return change(async () => {
      const action = parts[1];
      if (action === 'configure') {
        const next = serviceUrl(body?.serviceUrl);
        let notice = null;
        if (next !== state.serviceUrl) {
          notice = await signOut();
          save({ serviceUrl: next });
        }
        return json(res, 200, { ...await status(), ...(notice ? { notice } : {}) });
      }
      if (action === 'password') {
        await request(state,'auth/password',{oldPassword:body?.oldPassword,newPassword:body?.newPassword});
        save({serviceUrl:state.serviceUrl});return json(res,200,await status());
      }
      if (action === 'logout') {
        const notice = await signOut();
        return json(res, 200, { ...await status(), ...(notice ? { notice } : {}) });
      }
      if (action === 'login' || action === 'register') {
        if (!state.serviceUrl) throw new HttpError(400, 'Configure your cloud service first.');
        await signOut();
        const result = await request(state, `auth/${action}`, { username: body?.username, password: body?.password });
        if (typeof result.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.token)
          || typeof result.user?.id !== 'string' || typeof result.user?.username !== 'string') {
          throw new HttpError(502, 'The cloud service returned an invalid account.');
        }
        save({ serviceUrl: state.serviceUrl, token: result.token });
        return json(res, 200, await status());
      }
      throw new HttpError(404, 'Cloud operation not found.');
    });
  }
  cloudRoute.close=()=>transfers.close();
  return cloudRoute;
}
