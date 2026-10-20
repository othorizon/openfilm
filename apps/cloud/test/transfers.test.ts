import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudFixture, database } from './cloud-fixture.ts';
import { startStudio } from '../../../packages/openfilm/studio/server/server.mjs';

async function fixture() {
  const f = await cloudFixture({partBytes:102400});
  const scratch = await mkdtemp(join(tmpdir(),'openfilm-transfer-'));
  process.env.OPENFILM_HOME=join(scratch,'home'); process.env.OPENFILM_LIBRARY=join(scratch,'projects');
  let studio = await startStudio({port:0,openBrowser:()=>{}});
  const api = (path:string,body?:object)=>fetch(`${studio.origin}/api/${path}`,{method:body?'POST':'GET',headers:{'x-studio-key':studio.key!,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  await api('cloud/configure',{serviceUrl:f.cloud.origin});
  await api('cloud/register',{username:'alice',password:'alice-password-long'});
  const project = (await (await api('projects',{name:'Local film'})).json()).project;
  async function finish(id:string,expected='completed') {
    for (let i=0;i<200;i++) {
      const jobs = (await (await api('cloud/transfers')).json()).transfers;
      const job=jobs.find((x:any)=>x.id===id);
      if (['completed','error','paused','cancelled'].includes(job.state)) { assert.equal(job.state,expected,job.error); return job; }
      await new Promise(r=>setTimeout(r,25));
    }
    throw new Error('Transfer did not settle.');
  }
  return {...f,api,project,scratch,finish,async restartStudio(){await studio.close();studio=await startStudio({port:0,openBrowser:()=>{}});},async close(){await studio.close();await f.close();await rm(scratch,{recursive:true,force:true});}};
}

test('local Studio uploads direct to OSS and imports complete verified downloads without duplicate media',database,async()=>{
  const f=await fixture();
  try {
    const bytes=Buffer.alloc(230000,'x'); await writeFile(join(f.project.path,'source.png'),bytes);
    const body={direction:'upload',kind:'asset',projectId:f.project.id,path:'source.png',confirmed:true};
    assert.equal((await f.api('cloud/transfers',{...body,confirmed:false})).status,400);
    const response=await f.api('cloud/transfers',body);
    assert.equal(response.status,202,await response.clone().text());
    const uploaded=await f.finish((await response.json()).transfer.id);
    assert.ok(uploaded.item.id);
    const get=async()=>{
      const response=await f.api('cloud/transfers',{direction:'download',itemId:uploaded.item.id,projectId:f.project.id});
      assert.equal(response.status,202,await response.clone().text());
      return f.finish((await response.json()).transfer.id);
    };
    const downloaded=await get();
    assert.equal(downloaded.result.path,'assets/source.png');
    assert.deepEqual(await readFile(join(f.project.path,downloaded.result.path)),bytes);
    assert.equal((await get()).result.reused,true);
    assert.ok(f.oss.evidence.puts>=3);
  } finally {await f.close();}
});

test('failed uploads resume only missing parts after Studio restart, bind the original account and detect changed files',database,async()=>{
  const f=await fixture();
  try {
    const bytes=Buffer.alloc(230000,'r');await writeFile(join(f.project.path,'resume.png'),bytes);
    f.oss.evidence.failPut=2;
    const job=(await (await f.api('cloud/transfers',{direction:'upload',kind:'asset',projectId:f.project.id,path:'resume.png',confirmed:true})).json()).transfer;
    await f.finish(job.id,'error');const puts=f.oss.evidence.puts;
    await f.restartStudio();
    await f.api('cloud/register',{username:'bob',password:'bob-password-long'});
    assert.equal((await f.api(`cloud/transfers/${job.id}/resume`,{})).status,404);
    await f.api('cloud/login',{username:'alice',password:'alice-password-long'});
    await f.api(`cloud/transfers/${job.id}/resume`,{});
    await f.finish(job.id);
    assert.equal(f.oss.evidence.puts-puts,2,'the first part is not uploaded again');
    f.oss.evidence.failPut=2;
    const changed=(await (await f.api('cloud/transfers',{direction:'upload',kind:'asset',projectId:f.project.id,path:'resume.png',confirmed:true})).json()).transfer;
    await f.finish(changed.id,'error');await writeFile(join(f.project.path,'resume.png'),Buffer.alloc(230000,'c'));
    await f.api(`cloud/transfers/${changed.id}/resume`,{});
    assert.match((await f.finish(changed.id,'error')).error,/changed/);
    assert.equal((await f.api(`cloud/transfers/${changed.id}/cancel`,{})).status,200);
    assert.equal((await f.api(`cloud/transfers/${changed.id}/pause`,{})).status,409);
    assert.equal((await f.api(`cloud/transfers/${changed.id}/resume`,{})).status,409);
    assert.equal((await f.api(`cloud/transfers/${changed.id}/cancel`,{})).status,200);
  } finally {await f.close();}
});

test('downloads recover from interrupted ranges and expired links, and do not import withdrawn content',database,async()=>{
  const f=await fixture();
  try {
    const alice=await (await f.ask('auth/login',undefined,{username:'alice',password:'alice-password-long'})).json();
    const item=await f.upload(alice.token,Buffer.alloc(90000,'d'));
    f.oss.evidence.interruptGet=true;
    const job=(await (await f.api('cloud/transfers',{direction:'download',itemId:item.id,projectId:f.project.id})).json()).transfer;
    await f.finish(job.id,'error');await f.restartStudio();
    f.oss.evidence.rejectGet=true;
    await f.api(`cloud/transfers/${job.id}/resume`,{});const done=await f.finish(job.id);
    assert.equal((await readFile(join(f.project.path,done.result.path))).length,90000);
    await f.ask(`items/${item.id}/publish`,alice.token,{confirmed:true});
    await f.api('cloud/register',{username:'bob',password:'bob-password-long'});
    f.oss.evidence.interruptGet=true;
    const denied=(await (await f.api('cloud/transfers',{direction:'download',itemId:item.id,projectId:f.project.id})).json()).transfer;
    await f.finish(denied.id,'error');
    await f.ask(`items/${item.id}/withdraw`,alice.token,{});
    await f.api(`cloud/transfers/${denied.id}/resume`,{});
    assert.match((await f.finish(denied.id,'error')).error,/not found|no longer shared/);
  } finally {await f.close();}
});

test('cloud snapshots restore a new offline project with portable state and materialized approved links',database,async()=>{
  const f=await fixture();
  try {
    const {mkdir,symlink}=await import('node:fs/promises');
    const {addLinkedPlaces}=await import('../../../packages/openfilm/src/media-links.mjs');
    const external=join(f.scratch,'external');await mkdir(external);await writeFile(join(external,'clip.png'),Buffer.from('linked image'));
    addLinkedPlaces([external]);await mkdir(join(f.project.path,'assets'));await symlink(external,join(f.project.path,'assets','linked'),'dir');
    await writeFile(join(f.project.path,'title.html'),'<div data-duration="2">Draft</div>');
    await f.api(`projects/${f.project.id}/edit`,{ops:[{op:'insert',clip:{src:'title.html'}}]});
    await writeFile(join(f.project.path,'.film','markers.json'),'[{"time":1}]');
    await writeFile(join(f.project.path,'.env'),'SECRET=never-upload');
    await writeFile(join(f.project.path,'.film','chat.json'),'private conversation');
    const response=await f.api('cloud/transfers',{direction:'upload',kind:'snapshot',projectId:f.project.id,confirmed:true});
    assert.equal(response.status,202,await response.clone().text());
    const uploaded=await f.finish((await response.json()).transfer.id);
    await rm(external,{recursive:true});
    const download=await f.api('cloud/transfers',{direction:'download',itemId:uploaded.item.id,projectId:f.project.id});
    const restored=await f.finish((await download.json()).transfer.id);
    assert.notEqual(restored.result.project.id,f.project.id);
    const root=restored.result.project.path;
    assert.equal(await readFile(join(root,'assets/linked/clip.png'),'utf8'),'linked image');
    assert.equal(await readFile(join(root,'.film/markers.json'),'utf8'),'[{"time":1}]');
    await assert.rejects(readFile(join(root,'.env')));await assert.rejects(readFile(join(root,'.film/chat.json')));
    assert.match(await readFile(join(root,'film.html'),'utf8'),/title.html/);
    assert.equal((await f.api(`projects/${restored.result.project.id}`)).status,200);
  } finally {await f.close();}
});

test('snapshot packaging rejects missing required media and restore rejects traversal and incomplete archives',database,async()=>{
  const f=await fixture();
  try {
    await writeFile(join(f.project.path,'missing.html'),'<div data-duration="2">Missing</div>');
    await f.api(`projects/${f.project.id}/edit`,{ops:[{op:'insert',clip:{src:'missing.html'}}]});
    await rm(join(f.project.path,'missing.html'));
    const bad=(await (await f.api('cloud/transfers',{direction:'upload',kind:'snapshot',projectId:f.project.id,confirmed:true})).json()).transfer;
    assert.match((await f.finish(bad.id,'error')).error,/missing/);
    const {zipFiles}=await import('../../../packages/openfilm/studio/server/zip.mjs');
    const alice=await (await f.ask('auth/login',undefined,{username:'alice',password:'alice-password-long'})).json();
    for(const name of ['../escaped.txt','film.html']) {
      const path=join(f.scratch,'bad.zip');await zipFiles(path,[{name,data:Buffer.from('bad')}]);
      const item=await f.upload(alice.token,await readFile(path),{kind:'snapshot',name:'bad.zip',projectId:f.project.id});
      const job=(await (await f.api('cloud/transfers',{direction:'download',itemId:item.id,projectId:f.project.id})).json()).transfer;
      await f.finish(job.id,'error');
      await assert.rejects(readFile(join(f.scratch,'projects','escaped.txt')));
    }
  } finally {await f.close();}
});

test('a single upload with a lost PUT response resumes completion; transfer actions reject GET',database,async()=>{
  const f=await fixture();
  try {
    await writeFile(join(f.project.path,'small.png'),Buffer.from('small upload'));
    f.oss.evidence.interruptPut=true;
    const job=(await (await f.api('cloud/transfers',{direction:'upload',kind:'asset',projectId:f.project.id,path:'small.png',confirmed:true})).json()).transfer;
    await f.finish(job.id,'error');
    assert.equal((await f.api(`cloud/transfers/${job.id}/cancel`)).status,404);
    const puts=f.oss.evidence.puts;
    await f.restartStudio();await f.api(`cloud/transfers/${job.id}/resume`,{});
    assert.ok((await f.finish(job.id)).item.id);assert.equal(f.oss.evidence.puts,puts,'already received single PUT is not repeated');
  } finally {await f.close();}
});

test('a snapshot rejects a missing resource referenced inside an existing scene',database,async()=>{
  const f=await fixture();
  try {
    await writeFile(join(f.project.path,'scene.html'),'<div data-duration="2"><img src="missing.png"></div>');
    await f.api(`projects/${f.project.id}/edit`,{ops:[{op:'insert',clip:{src:'scene.html'}}]});
    const job=(await (await f.api('cloud/transfers',{direction:'upload',kind:'snapshot',projectId:f.project.id,confirmed:true})).json()).transfer;
    assert.match((await f.finish(job.id,'error')).error,/missing.png/);
    await writeFile(join(f.project.path,'scene.html'),'<div data-duration="2"><script>fetch("missing.json")</script></div>');
    const retry=(await (await f.api('cloud/transfers',{direction:'upload',kind:'snapshot',projectId:f.project.id,confirmed:true})).json()).transfer;
    assert.match((await f.finish(retry.id,'error')).error,/missing.json/);
  } finally {await f.close();}
});

test('multipart completion survives a lost OSS response without uploading again',database,async()=>{
  const f=await fixture();
  try {
    await writeFile(join(f.project.path,'complete.png'),Buffer.alloc(230000,'c'));
    f.oss.evidence.interruptComplete=true;
    const job=(await (await f.api('cloud/transfers',{direction:'upload',kind:'asset',projectId:f.project.id,path:'complete.png',confirmed:true})).json()).transfer;
    await f.finish(job.id,'error');const puts=f.oss.evidence.puts;
    await f.restartStudio();await f.api(`cloud/transfers/${job.id}/resume`,{});
    assert.ok((await f.finish(job.id)).item.id);assert.equal(f.oss.evidence.puts,puts);
  } finally {await f.close();}
});

test('a restarted range download keeps verified chunks and fetches only the missing suffix',database,async()=>{
  const f=await fixture();
  try {
    const content=Buffer.alloc(5*1024*1024,'r');await writeFile(join(f.project.path,'range.png'),content);
    const upload=(await (await f.api('cloud/transfers',{direction:'upload',kind:'asset',projectId:f.project.id,path:'range.png',confirmed:true})).json()).transfer;
    const item=(await f.finish(upload.id)).item;
    f.oss.evidence.interruptGetAt=f.oss.evidence.gets+2;
    const job=(await (await f.api('cloud/transfers',{direction:'download',itemId:item.id,projectId:f.project.id})).json()).transfer;
    const interrupted=await f.finish(job.id,'error');assert.equal(interrupted.progress,4*1024*1024);
    await f.restartStudio();const gets=f.oss.evidence.gets;
    await f.api(`cloud/transfers/${job.id}/resume`,{});const completed=await f.finish(job.id);
    assert.equal(f.oss.evidence.gets-gets,1);assert.deepEqual(await readFile(join(f.project.path,completed.result.path)),content);
  } finally {await f.close();}
});
