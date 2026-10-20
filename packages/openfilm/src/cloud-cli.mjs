// @ts-check
/** Cloud commands use the same local Studio account as the desktop; passwords are read from stdin, never argv. */
import { ensureStudio } from '../studio/client.mjs';

const HELP = `openfilm cloud configure <https://your-cloud-service>
openfilm cloud register <username> --password-stdin
openfilm cloud login <username> --password-stdin
openfilm cloud status
openfilm cloud logout

Configure once on this device. HTTP is allowed only on localhost for development.
For register/login, pipe the password on stdin (a final newline is removed).
Responses are JSON. Cloud tokens are kept by local Studio, outside your projects.
Exit status: 0 success, 1 request failed, 2 invalid command.`;

/** @param {string[]} args */
export async function cloudCommand(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const [action, value, flag] = args;
  const auth = action === 'login' || action === 'register';
  if (!(action === 'configure' && args.length === 2)
    && !(auth && args.length === 3 && flag === '--password-stdin')
    && !(['status', 'logout'].includes(action) && args.length === 1)) {
    console.error(HELP); return 2;
  }
  /** @type {Record<string, unknown> | undefined} */
  let body = action === 'configure' ? { serviceUrl: value } : action === 'logout' ? {} : undefined;
  if (auth) {
    if (process.stdin.isTTY) { console.error('Pipe the password on stdin, or sign in through Settings → Cloud account.'); return 2; }
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 4096) { console.error('Password input is too large.'); return 2; }
      chunks.push(chunk);
    }
    body = { username: value, password: Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '') };
  }
  try {
    const studio = await ensureStudio(line => console.error(line));
    const response = await fetch(`${studio.origin}/api/cloud${action === 'status' ? '' : `/${action}`}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'x-studio-key': studio.key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) { console.error(String(result.error ?? 'Cloud operation failed.')); return 1; }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cloud operation failed.');
    return 1;
  }
}
