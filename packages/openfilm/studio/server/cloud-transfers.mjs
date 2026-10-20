/** Durable device-side transfers. Only metadata crosses the cloud API; bytes go directly to OSS. */
import { createReadStream, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { open, stat, rm, mkdir } from 'node:fs/promises';
import { basename, join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { studioHome, projectById } from './projects.mjs';
import { readable, importFile } from './files.mjs';
import { packSnapshot, restoreSnapshot } from './cloud-snapshots.mjs';
import { HttpError, json, readJson } from './http.mjs';

export async function hashes(path, signal) {
  const sha=createHash('sha256'), md5=createHash('md5'); let size=0;
  for await (const bytes of createReadStream(path,{signal})) { sha.update(bytes); md5.update(bytes); size+=bytes.length; }
  return {sha256:sha.digest('hex'),md5:md5.digest('base64'),size};
}
const digest = (bytes, algorithm='sha256', encoding='hex')=>createHash(algorithm).update(bytes).digest(encoding);
const safeId = value => typeof value==='string' && /^[a-f0-9-]{36}$/.test(value);
export function createCloudTransfers(connection) {
  const home=join(studioHome(),'cloud-transfers'); mkdirSync(home,{recursive:true,mode:0o700});
  const jobs=new Map(), running=new Map(), actions=new Map(); let closed=false;
  function save(job) {
    const target=join(home,`${job.id}.json`), tmp=`${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp,JSON.stringify(job),{mode:0o600,flag:'wx'});renameSync(tmp,target);jobs.set(job.id,job);
  }
  for (const file of readdirSync(home)) if (/^[a-f0-9-]{36}\.json$/.test(file)) {
    try {const job=JSON.parse(readFileSync(join(home,file),'utf8'));if(!safeId(job.id))continue;
      if (['running','queued'].includes(job.state)) job.state='paused';jobs.set(job.id,job);
    } catch { /* A torn or invalid checkpoint cannot be resumed. */ }
  }
  const visible=job=> {const {source,chunks,remote,requestId,...publicJob}=job;return publicJob;};
  function same(job,conn) {return job.serviceUrl===conn.serviceUrl && job.ownerId===conn.ownerId;}
  async function upload(job,conn,signal) {
    if (job.kind==='snapshot' && !job.source) {
      const project=await projectById(job.projectId),space=await conn.request('space');
      const source=join(home,`${job.id}.zip`);
      await packSnapshot(project,source,space.limits.snapshotBytes,signal);job.source=source;save(job);
    }
    const current=await hashes(job.source,signal);
    if (job.sha256 && (job.sha256!==current.sha256 || job.size!==current.size)) throw new Error('The source file changed. Cancel this transfer and upload it again.');
    Object.assign(job,current);save(job);
    if (!job.remote) {
      job.remote=await conn.request('uploads',{kind:job.kind,name:job.name,projectId:job.projectId,tags:job.tags,...current,requestId:job.requestId});save(job);
    }
    const remote=job.remote;
    const status=await conn.request(`uploads/${remote.id}/status`,{});
    if(status.state==='completed') {job.item=status.item;job.progress=job.size;return;}
    if(status.uploaded) {job.item=(await conn.request(`uploads/${remote.id}/complete`,{})).item;job.progress=job.size;return;}
    if (remote.mode==='multipart') {
      const received=new Map(status.parts.map(p=>[p.number,p]));
      const sentHash=createHash('sha256');
      const file=await open(job.source,'r');
      try {
        job.progress=0;
        for (let offset=0,number=1;offset<job.size;offset+=remote.partBytes,number++) {
          signal.throwIfAborted();conn.assertCurrent();
          const size=Math.min(remote.partBytes,job.size-offset), bytes=Buffer.alloc(size);
          const read=await file.read(bytes,0,size,offset);if(read.bytesRead!==size)throw new Error('Source file changed.');
          sentHash.update(bytes);
          const md5=digest(bytes,'md5','base64'),part=received.get(number);
          if (part && (part.size!==size || part.etag.replaceAll('"','').toLowerCase()!==digest(bytes,'md5'))) throw new Error('The uploaded part does not match the source file.');
          if (!part) {const grant=await conn.request(`uploads/${remote.id}/sign`,{partNumber:number,md5}); await put(grant,bytes,signal);}
          job.progress+=size;save(job);
        }
      } finally {await file.close();}
      if(sentHash.digest('hex')!==job.sha256)throw new Error('Source file changed during upload.');
    } else {
      const grant=await conn.request(`uploads/${remote.id}/sign`,{});
      const bytes=readFileSync(job.source);
      if (digest(bytes)!==job.sha256)throw new Error('Source file changed.');
      await put(grant,bytes,signal);job.progress=job.size;save(job);
    }
    signal.throwIfAborted();conn.assertCurrent();
    // Recheck the source before publishing: an in-place edit must never silently change this snapshot.
    if ((await hashes(job.source,signal)).sha256!==job.sha256)throw new Error('Source file changed during upload.');
    job.item=(await conn.request(`uploads/${remote.id}/complete`,{})).item;
  }
  async function put(grant,bytes,signal) {
    const response=await fetch(grant.url,{method:'PUT',headers:grant.headers,body:bytes,signal,redirect:'error'});
    if (!response.ok) throw new Error(`OSS upload failed (${response.status}). Resume to retry.`);
  }
  async function download(job,conn,signal) {
    let grant=await conn.request(`items/${job.itemId}/download`,{});
    const item=grant.item;
    if (job.sha256 && (job.sha256!==item.sha256 || job.size!==item.size || job.etag!==item.etag)) throw new Error('The cloud object changed. Start a new download.');
    Object.assign(job,{sha256:item.sha256,size:item.size,etag:item.etag,name:item.name,kind:item.kind,item});
    job.chunks??=[];
    const partial=join(home,`${job.id}.partial`),file=await open(partial,'a+',0o600);
    try {
      let offset=0;
      // A checkpoint is trusted only after every persisted chunk has been verified again.
      for (const chunk of job.chunks) {
        const bytes=Buffer.alloc(chunk.size),r=await file.read(bytes,0,bytes.length,offset);
        if(r.bytesRead!==bytes.length || digest(bytes)!==chunk.sha256)throw new Error('The partial download is damaged. Cancel it and start again.');
        offset+=chunk.size;
      }
      await file.truncate(offset);job.progress=offset;save(job);
      while(offset<item.size) {
        signal.throwIfAborted();conn.assertCurrent();
        const end=Math.min(offset+4*1024*1024,item.size)-1;
        const headers={range:`bytes=${offset}-${end}`,'if-match':item.etag};
        let response=await fetch(grant.url,{headers,signal,redirect:'error'});
        if ([401,403].includes(response.status)) {
          await response.body?.cancel();grant=await conn.request(`items/${job.itemId}/download`,{});
          response=await fetch(grant.url,{headers,signal,redirect:'error'});
        }
        if (response.status!==206 || response.headers.get('content-range')!==`bytes ${offset}-${end}/${item.size}` || response.headers.get('etag')!==item.etag) {
          await response.body?.cancel();throw new Error(`OSS range download failed (${response.status}). Resume to retry.`);
        }
        const parts=[];let length=0;
        for await(const bytes of response.body) {length+=bytes.length;if(length>end-offset+1)throw new Error('OSS returned too many bytes.');parts.push(bytes);}
        const bytes=Buffer.concat(parts);
        if(bytes.length!==end-offset+1)throw new Error('OSS download was interrupted. Resume to retry.');
        await file.write(bytes);await file.sync();
        job.chunks.push({size:bytes.length,sha256:digest(bytes)});offset+=bytes.length;job.progress=offset;save(job);
      }
    } finally {await file.close();}
    if ((await hashes(partial,signal)).sha256!==item.sha256)throw new Error('Downloaded file failed its SHA-256 checksum.');
    signal.throwIfAborted();conn.assertCurrent();
    if(item.kind==='snapshot') {
      const space=await conn.request('space');job.result=await restoreSnapshot(partial,space.limits.snapshotBytes,signal);
    } else {
    const project=await projectById(job.projectId);
    job.result=await importFile(project.path,`assets/${item.name}`,createReadStream(partial,{signal}));
    }
    await rm(partial,{force:true});
  }
  function start(job,conn) {
    if(closed || running.has(job.id))throw new HttpError(409,'Transfer is already running or Studio is closing.');
    const controller=new AbortController();job.state='running';delete job.error;save(job);
    const promise=(async()=>{
      try {await (job.direction==='upload'?upload:download)(job,conn,controller.signal);job.state='completed';}
      catch(error) {if(job.state!=='cancelled')job.state=controller.signal.aborted?'paused':'error';job.error=controller.signal.aborted?'Transfer paused.':error.message;}
      finally {if(job.state==='completed' && job.kind==='snapshot' && job.direction==='upload')await rm(join(home,`${job.id}.zip`),{force:true});save(job);running.delete(job.id);}
    })();
    running.set(job.id,{controller,promise});
  }
  async function stopAll() {for(const run of running.values())run.controller.abort();await Promise.all([...running.values()].map(r=>r.promise));}
  async function route(req,res,parts) {
    const conn=await connection();
    if (parts[1]==='items') {
      if(req.method==='GET' && parts.length===2)return json(res,200,await conn.request(`items${new URL(req.url,'http://localhost').search}`));
      if(req.method==='POST' && parts.length===4 && safeId(parts[2]) && ['download','publish','withdraw','delete','share'].includes(parts[3]))
        return json(res,200,await conn.request(`items/${parts[2]}/${parts[3]}`,await readJson(req,65536)));
      throw new HttpError(404,'Unknown library action.');
    }
    if(parts.length===2 && req.method==='GET')return json(res,200,{transfers:[...jobs.values()].filter(j=>same(j,conn)).map(visible).reverse()});
    const body=await readJson(req,65536);
    if(parts.length===2 && req.method==='POST') {
      if(!['upload','download'].includes(body.direction))throw new HttpError(400,'Choose upload or download.');
      let project;
      if (body.direction==='upload') project=await projectById(body.projectId);
      else {
        if(!safeId(body.itemId))throw new HttpError(400,'Choose cloud content.');
        const grant=await conn.request(`items/${body.itemId}/download`,{});
        if(grant.item.kind!=='snapshot')project=await projectById(body.projectId);
      }
      const job={id:randomUUID(),requestId:randomUUID(),direction:body.direction,kind:body.kind,projectId:project?.id,serviceUrl:conn.serviceUrl,ownerId:conn.ownerId,state:'queued',progress:0,createdAt:new Date().toISOString(),tags:body.tags??[]};
      if(body.direction==='upload') {
        if(body.confirmed!==true)throw new HttpError(400,'Confirm uploading this file to your cloud account.');
        if(body.kind==='snapshot') {job.name=`draft-${new Date().toISOString().replaceAll(':','-')}.zip`;} else {
        if(typeof body.path!=='string')throw new HttpError(400,'Choose a source file.');
        job.source=isAbsolute(body.path)?body.path:readable(project.path,body.path);
        if(!(await stat(job.source)).isFile())throw new HttpError(400,'Choose a regular file.');
        job.name=basename(job.source);
        }
      } else {if(!safeId(body.itemId))throw new HttpError(400,'Choose cloud content.');job.itemId=body.itemId;}
      save(job);start(job,conn);return json(res,202,{transfer:visible(job)});
    }
    if(req.method!=='POST' || parts.length!==4)throw new HttpError(404,'Unknown transfer action.');
    const job=jobs.get(parts[2]);
    if(!job || !same(job,conn))throw new HttpError(404,'Transfer not found for this account and service.');
    const action=(actions.get(job.id)??Promise.resolve()).then(async()=>{
    conn.assertCurrent();
    if(parts[3]==='pause' || parts[3]==='cancel') {
      const run=running.get(job.id);run?.controller.abort();await run?.promise;
      if(job.state==='completed' || (job.state==='cancelled' && parts[3]==='pause'))throw new HttpError(409,'This transfer has finished.');
      if(parts[3]==='cancel') {
        if(job.remote)await conn.request(`uploads/${job.remote.id}/cancel`,{});
        job.state='cancelled';if(job.kind==='snapshot' && job.direction==='upload')await rm(join(home,`${job.id}.zip`),{force:true});await rm(join(home,`${job.id}.partial`),{force:true});
      } else job.state='paused';save(job);
    } else if(parts[3]==='resume') {
      if(['completed','cancelled'].includes(job.state))throw new HttpError(409,'This transfer has finished.');start(job,conn);
    } else throw new HttpError(404,'Unknown transfer action.');
    return visible(job);
    });
    const settled=action.then(()=>{},()=>{});actions.set(job.id,settled);
    void settled.then(()=>{if(actions.get(job.id)===settled)actions.delete(job.id);});
    return json(res,200,{transfer:await action});
  }
  return {route,stopAll,async close(){closed=true;await stopAll();}};
}
