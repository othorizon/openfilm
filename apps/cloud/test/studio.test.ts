import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testDatabase } from './database.ts';
import { startCloud } from '../src/server.ts';
import { startStudio } from '../../../packages/openfilm/studio/server/server.mjs';

const database = { skip: !process.env.OPENFILM_TEST_DATABASE_URL && 'Set OPENFILM_TEST_DATABASE_URL for real PostgreSQL integration tests.' };
const binary = fileURLToPath(new URL('../../../packages/openfilm/bin/openfilm.mjs', import.meta.url));
function cli(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, 'cloud', ...args], { env: { ...process.env, OPENFILM_NO_UPDATE_CHECK: '1' }, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('Studio and CLI share a cloud account without putting credentials in a project', database, async () => {
  const db = await testDatabase();
  let cloud = await startCloud({ databaseUrl: db.url, port: 0 });
  const scratch = await mkdtemp(join(tmpdir(), 'openfilm-cloud-client-'));
  process.env.OPENFILM_HOME = join(scratch, 'home');
  process.env.OPENFILM_LIBRARY = join(scratch, 'projects');
  let studio = await startStudio({ port: 0, advertise: true, openBrowser: () => {} });
  const api = (path: string, body?: object) => fetch(`${studio.origin}/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-studio-key': studio.key!, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await api('cloud')).status, 200);
    const configured = await cli(['configure', cloud.origin]);
    assert.equal(configured.code, 0, configured.stderr);
    const register = await api('cloud/register', { username: 'alice', password: 'alice-password-long' });
    assert.equal(register.status, 200);
    const alice = await register.json();
    assert.equal(alice.user.username, 'alice');
    assert.equal(alice.token, undefined, 'the renderer does not receive cloud session tokens');
    const status = await cli(['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).user.id, alice.user.id);
    assert.equal(JSON.parse(status.stdout).space.ownerId, alice.user.id);
    assert.equal((await cli(['logout'])).code, 0);
    assert.equal((await (await api('cloud')).json()).user, null);
    const login = await cli(['login', 'alice', '--password-stdin'], 'alice-password-long\n');
    assert.equal(login.code, 0, login.stderr);
    assert.equal((await (await api('cloud')).json()).user.id, alice.user.id);

    const { project } = await (await api('projects', { name: 'Local project' })).json();
    const sessionFile = join(scratch, 'home', 'cloud-account.json');
    const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
    if (process.platform !== 'win32') assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(saved).includes('alice-password-long'));
    assert.equal((await readdir(project.path)).includes('cloud-account.json'), false);
    await studio.close();
    studio = await startStudio({ port: 0, advertise: true, openBrowser: () => {} });
    assert.equal((await (await api('cloud')).json()).user.id, alice.user.id, 'the same service session survives Studio restart');
    assert.equal((await fetch(`${studio.origin}/api/cloud`)).status, 401, 'the cloud bridge requires local Studio authorization');
    assert.equal((await api('cloud/configure', { serviceUrl: 'http://example.com' })).status, 400);
    assert.equal((await api('cloud/configure', { serviceUrl: 'https://user:password@example.com' })).status, 400);
    assert.equal((await api('cloud/login', { username: 'alice', password: 'wrong-password-long' })).status, 403);
    assert.equal((await (await api('cloud')).json()).user, null, 'a failed account switch cannot retain the previous identity');
    assert.equal((await fetch(`${cloud.origin}/v1/me`, { headers: { authorization: `Bearer ${saved.token}` } })).status, 401);
    const bob = await api('cloud/register', { username: 'bob', password: 'bob-password-long' });
    assert.equal((await bob.json()).user.username, 'bob');
    assert.equal((await api('projects')).status, 200, 'cloud authentication errors do not lock local projects');

    await cloud.close();
    const offline = await (await api('cloud')).json();
    assert.equal(offline.offline, true);
    assert.equal(offline.user, null);
    assert.equal((await api(`projects/${project.id}`)).status, 200);
    await writeFile(join(project.path, 'title.html'), '<div data-duration="3">Local title</div>');
    const edit = await api(`projects/${project.id}/edit`, { ops: [{ op: 'insert', clip: { src: 'title.html' } }] });
    assert.equal(edit.status, 200, await edit.text());
    assert.match(await readFile(join(project.path, 'film.html'), 'utf8'), /title.html/);
    const logout = await (await api('cloud/logout', {})).json();
    assert.equal(logout.hasSession, false);
    assert.match(logout.notice, /this device/);
    const oldUrl = cloud.origin;
    cloud = await startCloud({ databaseUrl: db.url, port: Number(new URL(oldUrl).port) });
    assert.equal((await api('cloud/login', { username: 'alice', password: 'alice-password-long' })).status, 200);
    const secondDb = await testDatabase();
    const second = await startCloud({ databaseUrl: secondDb.url, port: 0 });
    try {
      const switched = await (await api('cloud/configure', { serviceUrl: second.origin })).json();
      assert.equal(switched.hasSession, false);
      assert.equal(switched.user, null);
      const fresh = await (await api('cloud/register', { username: 'alice', password: 'another-password-long' })).json();
      assert.notEqual(fresh.user.id, alice.user.id, 'same username on a different service is a different identity');
      await api('cloud/configure', { serviceUrl: oldUrl });
      assert.equal((await (await api('cloud')).json()).hasSession, false, 'switching back does not restore an old session');
    } finally { await second.close(); await secondDb.close(); }
  } finally {
    await studio.close(); await cloud.close(); await db.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
