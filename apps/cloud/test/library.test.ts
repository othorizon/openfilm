import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startCloud } from '../src/server.ts';
import { testDatabase } from './database.ts';
import { ossServer } from './oss-server.ts';
import { cloudFixture, fileMetadata } from './cloud-fixture.ts';

const database = { skip: !process.env.OPENFILM_TEST_DATABASE_URL };
const bytes = Buffer.from('a small test image');
const metadata = (name = 'picture.png', body = bytes) => ({
  name, kind: 'asset', mediaType: 'image', contentType: 'image/png', size: body.length,
  sha256: createHash('sha256').update(body).digest('hex'), md5: createHash('md5').update(body).digest('base64'), tags: ['sample'],
});
test('a private asset uploads directly to OSS, completes once and downloads with a three-hour grant', database, async () => {
  const db = await testDatabase(), oss = await ossServer();
  const cloud = await startCloud({ databaseUrl: db.url, port: 0, ...{ storage: oss.config } });
  const ask = (path: string, token?: string, body?: object) => fetch(`${cloud.origin}/v1/${path}`, {
    method: body ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const { token } = await (await ask('auth/register', undefined, { username: 'alice', password: 'alice-password-long' })).json();
    const task = await ask('uploads', token, metadata()); assert.equal(task.status, 201);
    const upload = await task.json(); assert.ok(upload.id); assert.equal(upload.mode, 'single');
    assert.equal((await ask(`uploads/${upload.id}/complete`, token, {})).status, 409, 'a forged success cannot publish absent bytes');
    const grant = await (await ask(`uploads/${upload.id}/sign`, token, {})).json();
    assert.equal(new URL(grant.url).origin, oss.config.endpoint);
    assert.equal((await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: bytes })).status, 200);
    const done = await ask(`uploads/${upload.id}/complete`, token, {}); assert.equal(done.status, 200);
    const item = (await done.json()).item;
    assert.equal(item.visibility, 'private');
    assert.equal((await (await ask(`uploads/${upload.id}/complete`, token, {})).json()).item.id, item.id);
    assert.equal((await (await ask('space', token)).json()).usedBytes, bytes.length);
    assert.equal((await (await ask('space', token)).json()).reservedBytes, 0);
    const download = await (await ask(`items/${item.id}/download`, token, {})).json();
    assert.equal(Number(new URL(download.url).searchParams.get('x-oss-expires')), 10800);
    assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), bytes);
    const bob = await (await ask('auth/register', undefined, { username: 'bob', password: 'bob-password-long' })).json();
    assert.equal((await ask(`items/${item.id}/download`, bob.token, {})).status, 404);
    assert.equal((await ask(`uploads/${upload.id}/sign`, bob.token, {})).status, 404);
    assert.equal((await (await ask('items', bob.token)).json()).items.length, 0);
    assert.equal(oss.evidence.puts, 1); assert.equal(oss.evidence.copies, 1);
    // An old staging grant can never modify the published object.
    await fetch(grant.url, { method: 'PUT', headers: grant.headers, body: bytes });
    assert.deepEqual(Buffer.from(await (await fetch(download.url)).arrayBuffer()), bytes);
  } finally { await cloud.close(); await oss.close(); await db.close(); }
});

test('concurrent reservations obey quota; cancel, expiry and confirmed deletion release capacity', database, async () => {
  const f = await cloudFixture({ quotaBytes: 30, fileBytes: 25, uploadSeconds: 1, cleanupSeconds: 1 });
  try {
    const { token } = await f.register('alice');
    const payload = Buffer.alloc(20, 'x');
    const starts = await Promise.all([f.ask('uploads', token, fileMetadata(payload)), f.ask('uploads', token, fileMetadata(payload))]);
    assert.deepEqual(starts.map(r=>r.status).sort(), [201,409]);
    const t = await starts.find(r=>r.status===201)!.json();
    assert.equal((await (await f.ask('space',token)).json()).reservedBytes,20);
    assert.equal((await f.ask(`uploads/${t.id}/cancel`,token,{})).status,200);
    assert.equal((await f.ask(`uploads/${t.id}/cancel`,token,{})).status,200);
    assert.equal((await f.ask(`uploads/${t.id}/sign`,token,{})).status,410);
    assert.equal((await (await f.ask('space',token)).json()).reservedBytes,0);
    const item = await f.upload(token,payload);
    assert.equal((await f.ask(`items/${item.id}/delete`,token,{})).status,400);
    assert.equal((await f.ask(`items/${item.id}/delete`,token,{ confirmed:true })).status,200);
    assert.equal((await (await f.ask('space',token)).json()).usedBytes,0);
    const expired = await (await f.ask('uploads',token,fileMetadata(payload))).json();
    await new Promise(resolve=>setTimeout(resolve,2200));
    assert.equal((await f.ask(`uploads/${expired.id}/sign`,token,{})).status,410);
    assert.equal((await (await f.ask('space',token)).json()).reservedBytes,0);
    assert.equal((await f.ask('uploads',token,fileMetadata(Buffer.alloc(26)))).status,413);
  } finally { await f.close(); }
});

test('publishing allows another account to search and preview; withdrawal stops new grants without changing downloaded bytes', database, async () => {
  const f = await cloudFixture();
  try {
    const alice = await f.register('alice'), bob = await f.register('bob');
    const item = await f.upload(alice.token, bytes, { tags:['forest','spring'] });
    assert.equal((await f.ask(`items/${item.id}/publish`, alice.token, {})).status,400);
    assert.equal((await f.ask(`items/${item.id}/publish`, bob.token, { confirmed:true })).status,404);
    assert.equal((await f.ask(`items/${item.id}/publish`, alice.token, { confirmed:true })).status,200);
    const search = await (await f.ask('items?scope=public&q=pic&tag=forest&type=image', bob.token)).json();
    assert.equal(search.items[0].id,item.id);
    assert.equal((await (await f.ask('items?scope=public&tag=other',bob.token)).json()).items.length,0);
    const grant = await (await f.ask(`items/${item.id}/download`,bob.token,{})).json();
    const localCopy = Buffer.from(await (await fetch(grant.url)).arrayBuffer());
    assert.deepEqual(localCopy,bytes);
    assert.equal((await f.ask(`items/${item.id}/withdraw`,bob.token,{})).status,403);
    assert.equal((await f.ask(`items/${item.id}/withdraw`,alice.token,{})).status,200);
    assert.equal((await (await f.ask('items?scope=public',bob.token)).json()).items.length,0);
    assert.equal((await f.ask(`items/${item.id}/download`,bob.token,{})).status,404);
    assert.deepEqual(localCopy,bytes);
    assert.equal((await f.ask(`items/${item.id}/download`,undefined,{})).status,401);
  } finally { await f.close(); }
});

test('multipart uploads resume after service restart and reject missing, changed or foreign parts', database, async () => {
  const f = await cloudFixture({ partBytes: 102400 });
  try {
    const alice = await f.register('alice'), bob = await f.register('bob');
    const content = Buffer.alloc(230000, 'm');
    const task = await (await f.ask('uploads',alice.token,fileMetadata(content))).json();
    assert.equal(task.mode,'multipart');
    const part = async (number: number) => {
      const bytes = content.subarray((number-1)*task.partBytes,Math.min(number*task.partBytes,content.length));
      const md5 = createHash('md5').update(bytes).digest('base64');
      const response = await f.ask(`uploads/${task.id}/sign`,alice.token,{ partNumber:number,md5 });
      assert.equal(response.status,200,await response.clone().text());
      const grant = await response.json();
      assert.equal((await fetch(grant.url,{ method:'PUT',headers:grant.headers,body:bytes })).status,200);
    };
    await part(1);
    assert.equal((await f.ask(`uploads/${task.id}/complete`,alice.token,{})).status,409);
    assert.equal((await f.ask(`uploads/${task.id}/sign`,alice.token,{partNumber:0,md5:fileMetadata(content).md5})).status,400);
    assert.equal((await f.ask(`uploads/${task.id}/sign`,bob.token,{partNumber:2,md5:fileMetadata(content).md5})).status,404);
    assert.equal((await f.ask(`uploads/${task.id}/sign`,alice.token,{partNumber:1,md5:fileMetadata(Buffer.from('changed')).md5})).status,409);
    await f.restart();
    const progress = await (await f.ask(`uploads/${task.id}/status`,alice.token,{})).json();
    assert.equal(progress.parts[0].number,1);
    assert.equal(progress.parts[0].size,102400);
    await part(2); await part(3);
    const completed = await (await f.ask(`uploads/${task.id}/complete`,alice.token,{})).json();
    assert.ok(completed.item.id);
    assert.equal((await (await f.ask(`uploads/${task.id}/complete`,alice.token,{})).json()).item.id,completed.item.id);
    assert.equal((await (await f.ask('space',alice.token)).json()).usedBytes,content.length);
    const grant = await (await f.ask(`items/${completed.item.id}/download`,alice.token,{})).json();
    assert.deepEqual(Buffer.from(await (await fetch(grant.url)).arrayBuffer()),content);
  } finally { await f.close(); }
});


test('results share the same charged object with assets until the final reference is deleted', database, async () => {
  const f = await cloudFixture();
  try {
    const alice = await f.register('alice'), bob = await f.register('bob');
    const result = await f.upload(alice.token,bytes,{kind:'result',projectId:'film-1'});
    assert.equal((await f.ask(`items/${result.id}/publish`,alice.token,{confirmed:true})).status,400);
    const shared = await f.ask(`items/${result.id}/share`,alice.token,{confirmed:true});
    assert.equal(shared.status,200,await shared.clone().text());
    const asset = (await shared.json()).item;
    assert.equal(asset.kind,'asset');
    assert.equal(asset.visibility,'public');
    assert.equal((await (await f.ask('space',alice.token)).json()).usedBytes,bytes.length);
    assert.equal((await f.ask(`items/${result.id}/delete`,alice.token,{confirmed:true})).status,200);
    assert.equal((await f.ask(`items/${asset.id}/download`,bob.token,{})).status,200);
    assert.equal((await (await f.ask('space',alice.token)).json()).usedBytes,bytes.length);
    assert.equal((await f.ask(`items/${asset.id}/delete`,alice.token,{confirmed:true})).status,200);
    assert.equal((await (await f.ask('space',alice.token)).json()).usedBytes,0);
    const archive = await f.upload(alice.token,bytes,{kind:'result',name:'bundle.zip',projectId:'film-1'});
    assert.equal((await f.ask(`items/${archive.id}/share`,alice.token,{confirmed:true})).status,400);
  } finally { await f.close(); }
});
