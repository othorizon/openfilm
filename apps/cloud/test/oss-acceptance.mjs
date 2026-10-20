/** Opt-in real OSS acceptance. The operator supplies a private config file and a disposable PostgreSQL database. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { testDatabase } from './database.ts';
import { startCloud } from '../src/server.ts';
import { Storage } from '../src/storage.ts';

if(!process.env.OPENFILM_OSS_TEST_CONFIG)throw new Error('Set OPENFILM_OSS_TEST_CONFIG to an operator-owned JSON file.');
const original=JSON.parse(await readFile(process.env.OPENFILM_OSS_TEST_CONFIG,'utf8'));
const prefix=original.prefix ?? original.prefixes?.[0];
if(!prefix)throw new Error('A dedicated test prefix is required.');
const config={...original,prefix:`${prefix.replace(/\/+$/,'')}/acceptance-${randomUUID()}/`};
const store=new Storage(config),db=await testDatabase();
let cloud=await startCloud({databaseUrl:db.url,port:0,storage:config,limits:{partBytes:102400,cleanupSeconds:1}});
const objects=new Set(),uploads=new Map();
async function ask(path,token,body) {
  const r=await fetch(`${cloud.origin}/v1/${path}`,{method:body?'POST':'GET',headers:{...(token?{authorization:`Bearer ${token}`} :{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const value=await r.json();assert.ok(r.ok,`Cloud ${path}: ${r.status} ${value.error??''}`);return value;
}
const hash=(bytes,type,encoding)=>createHash(type).update(bytes).digest(encoding);
async function upload(token,bytes) {
  const t=await ask('uploads',token,{kind:'asset',name:'acceptance.png',size:bytes.length,sha256:hash(bytes,'sha256','hex'),md5:hash(bytes,'md5','base64')});
  const status=await ask('me',token);objects.add(store.key(status.id,t.id));objects.add(store.key(status.id,t.id,true));
  const part=async number=>{
    const chunk=t.mode==='single'?bytes:bytes.subarray((number-1)*t.partBytes,number*t.partBytes);
    const g=await ask(`uploads/${t.id}/sign`,token,t.mode==='single'?{}:{partNumber:number,md5:hash(chunk,'md5','base64')});
    if(t.mode==='multipart')uploads.set(store.key(status.id,t.id),new URL(g.url).searchParams.get('uploadId'));
    const r=await fetch(g.url,{method:'PUT',headers:g.headers,body:chunk});
    assert.equal(r.status,200,`OSS PUT status ${r.status}`);
  };
  await part(1);
  if(t.mode==='multipart') {
    const port=Number(new URL(cloud.origin).port);await cloud.close();cloud=await startCloud({databaseUrl:db.url,port,storage:config,limits:{partBytes:102400,cleanupSeconds:1}});
    assert.equal((await ask(`uploads/${t.id}/status`,token,{})).parts.length,1);
    for(let n=2;n<=Math.ceil(bytes.length/t.partBytes);n++)await part(n);
  }
  const done=await ask(`uploads/${t.id}/complete`,token,{});
  assert.equal((await ask(`uploads/${t.id}/complete`,token,{})).item.id,done.item.id);
  const g=await ask(`items/${done.item.id}/download`,token,{});
  assert.equal(g.expiresIn,10800);assert.equal(new URL(g.url).searchParams.get('x-oss-expires'),'10800');
  const r=await fetch(g.url);if(!r.ok){const xml=await r.text();console.error('OSS GET:',xml.match(/<Code>([^<]+)<\/Code>/)?.[1],xml.match(/<Message>([^<]+)<\/Message>/)?.[1]);}assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  const range=await fetch(g.url,{headers:{range:'bytes=1-3','if-match':done.item.etag}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),bytes.subarray(1,4));
  return done.item;
}
try {
  const alice=await ask('auth/register',null,{username:'alice',password:'real-oss-test-password'});
  const bob=await ask('auth/register',null,{username:'bob',password:'real-oss-test-password'});
  const small=await upload(alice.token,Buffer.from('real OSS direct upload acceptance'));
  console.log('Real OSS: private direct PUT, immutable completion, idempotency, 10800-second download and Range passed.');
  await upload(alice.token,Buffer.alloc(230000,'multipart'));
  console.log('Real OSS: multipart upload, service restart, list-parts resume and byte verification passed.');
  await ask(`items/${small.id}/publish`,alice.token,{confirmed:true});
  assert.equal((await ask('items?scope=public',bob.token)).items.length,1);
  const copy=await ask(`items/${small.id}/download`,bob.token,{});assert.equal((await fetch(copy.url)).status,200);
  await ask(`items/${small.id}/withdraw`,alice.token,{});assert.equal((await ask('items?scope=public',bob.token)).items.length,0);
  const bytes=Buffer.alloc(220000,'cancel');
  const pending=await ask('uploads',alice.token,{kind:'asset',name:'cancel.png',size:bytes.length,sha256:hash(bytes,'sha256','hex'),md5:hash(bytes,'md5','base64')});
  const g=await ask(`uploads/${pending.id}/sign`,alice.token,{partNumber:1,md5:hash(bytes.subarray(0,102400),'md5','base64')});
  const key=store.key(alice.user.id,pending.id),uploadId=new URL(g.url).searchParams.get('uploadId');objects.add(key);uploads.set(key,uploadId);
  assert.equal((await fetch(g.url,{method:'PUT',headers:g.headers,body:bytes.subarray(0,102400)})).status,200);
  await ask(`uploads/${pending.id}/cancel`,alice.token,{});
  let cleaned=false;
  for(let i=0;i<20;i++){try{await store.parts(key,uploadId);}catch(error){if(error.status===404){cleaned=true;break;}throw error;}await new Promise(r=>setTimeout(r,250));}
  assert.ok(cleaned,'cancelled multipart is aborted by cleanup');
  console.log('Real OSS: two-account sharing, withdrawal and cancelled multipart cleanup passed.');
} finally {
  await cloud.close();
  // Exact keys and upload IDs created by this process only; never delete a whole user prefix.
  for(const [key,id] of uploads)await store.remove(key,id);
  for(const key of objects)await store.remove(key);
  await db.close();
  console.log('Real OSS acceptance objects and multipart tasks cleaned up.');
}
