import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testDatabase } from './database.ts';
import { cloudFixture, database } from './cloud-fixture.ts';
import { startCloud } from '../src/server.ts';

export function admin(databaseUrl: string, args: string[], password = ''): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/admin.ts', import.meta.url)), ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
    child.stdin.end(password);
  });
}

test('server operator initializes administration, resets a password and disables existing sessions', {
  skip: !process.env.OPENFILM_TEST_DATABASE_URL,
}, async () => {
  const db = await testDatabase();
  const cloud = await startCloud({ databaseUrl: db.url, port: 0 });
  const auth = (action: string, username: string, password: string) => fetch(`${cloud.origin}/v1/auth/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  try {
    await auth('register', 'operator', 'operator-password-long');
    const { token } = await (await auth('register', 'alice', 'alice-password-long')).json();
    assert.equal((await admin(db.url, ['reset', 'alice', '--as', 'operator', '--password-stdin'], 'new-password-long')).code, 1);
    const init = await admin(db.url, ['init', 'operator']);
    assert.equal(init.code, 0, init.output);
    const reset = await admin(db.url, ['reset', 'alice', '--as', 'operator', '--password-stdin'], 'new-password-long');
    assert.equal(reset.code, 0, reset.output);
    assert.ok(!reset.output.includes('new-password-long'));
    assert.equal((await fetch(`${cloud.origin}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await auth('login', 'alice', 'alice-password-long')).status, 401);
    const fresh = await (await auth('login', 'alice', 'new-password-long')).json();
    assert.ok(fresh.token);
    assert.equal((await admin(db.url, ['disable', 'alice', '--as', 'operator'])).code, 0);
    assert.equal((await fetch(`${cloud.origin}/v1/space`, { headers: { authorization: `Bearer ${fresh.token}` } })).status, 401);
    assert.equal((await auth('login', 'alice', 'new-password-long')).status, 401);
  } finally { await cloud.close(); await db.close(); }
});


test('administrator removal persists across restart and prevents result aliases from republishing', database, async () => {
  const f = await cloudFixture();
  try {
    await f.register('operator');
    const alice = await f.register('alice'), bob = await f.register('bob');
    await admin(f.db.url,['init','operator']);
    const result = await f.upload(alice.token,Buffer.from('video-content'),{kind:'result',name:'render.mp4',projectId:'film-1'});
    const asset = (await (await f.ask(`items/${result.id}/share`,alice.token,{confirmed:true})).json()).item;
    const removed = await admin(f.db.url,['remove',asset.id,'--as','operator']);
    assert.equal(removed.code,0,removed.output);
    await f.restart();
    assert.equal((await f.ask(`items/${asset.id}/download`,bob.token,{})).status,404);
    assert.equal((await f.ask(`items/${asset.id}/publish`,alice.token,{confirmed:true})).status,403);
    await f.ask(`items/${asset.id}/delete`,alice.token,{confirmed:true});
    assert.equal((await f.ask(`items/${result.id}/share`,alice.token,{confirmed:true})).status,403);
    assert.equal((await f.ask(`items/${result.id}/download`,alice.token,{})).status,200);
  } finally { await f.close(); }
});
