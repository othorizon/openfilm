/** Portable, versioned cloud drafts. Packaging and extraction happen only on the local device. */
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { readable } from './files.mjs';
import { libraryRoot, openProject } from './projects.mjs';
import { STUDIO_STATE, projectPath } from './closure.mjs';
import { readFilmFile } from '../../src/film-doc.mjs';
import { zipFiles } from './zip.mjs';

const MANIFEST='openfilm-snapshot.json';
const SKIP=new Set(['node_modules','dist','build','cache','logs','exports','renders']);
const MAX_FILES=100000;
function safePath(name) {
  return typeof name==='string' && name.length<=1000 && !/[\\:\x00-\x1f]/.test(name) && name.split('/').every(p=>
    p && p!=='.' && p!=='..' && !/~\d/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p));
}
function portable(name) {
  return safePath(name) && !/\.log$/i.test(name) && (STUDIO_STATE.includes(name) || name.split('/').every(p=>!p.startsWith('.') && !SKIP.has(p.toLowerCase())));
}
async function sha256(file,signal) {
  const hash=createHash('sha256');for await(const bytes of createReadStream(file,{signal}))hash.update(bytes);return hash.digest('hex');
}
async function verifyFilm(root,files) {
  if(!files.has('film.html'))throw new Error('A draft must contain film.html.');
  // Explicit local resource references must resolve; a page alone is not a complete draft.
  for(const name of files) {
    if(!/\.(html?|css|[mc]?js)$/i.test(name))continue;
    if((await stat(join(root,name))).size>4*1024*1024)continue;
    const text=await readFile(join(root,name),'utf8'),refs=[];
    if(/\.html?$/i.test(name)) {
      for(const match of text.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi))refs.push(match[1]);
      for(const match of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi))for(const entry of match[1].split(','))refs.push(entry.trim().split(/\s+/)[0]);
    }
    for(const match of text.matchAll(/url\(\s*["']?([^\s)"']+)["']?\s*\)|@import\s+["']([^"']+)["']/gi))refs.push(match[1]??match[2]);
    for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      if(match[1].startsWith('.') || match[1].startsWith('/'))refs.push(match[1]);
    }
    for(const match of text.matchAll(/\bfetch\s*\(\s*["']([^"']+)["']/g))refs.push(match[1]);
    for(const match of text.matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g))refs.push(match[1]);
    for(const ref of refs) {
      const path=projectPath(ref,dirname(name).split(sep).join('/'));
      if(path && !files.has(path))throw new Error(`Required project file is missing: ${path}`);
    }
  }
  const film=readFilmFile(await readFile(join(root,'film.html'),'utf8')).value;
  for(const track of film.tracks??[])for(const clip of track.clips??[]) {
    const path=projectPath(clip.src??'','');
    if(path && !files.has(path))throw new Error(`Required project file is missing: ${path}`);
  }
}
export async function packSnapshot(project,out,limit,signal) {
  const stage=await mkdtemp(join(dirname(out),'snapshot-'));
  const portableNames=new Set();
  const entries=[],manifest={format:'openfilm-cloud-snapshot',version:1,name:project.name,files:[]};let total=0;
  const root=await realpath(project.path);
  async function stageSnapshotFile(name,source) {
    signal.throwIfAborted();
    if(!portable(name) || name.normalize('NFC').toLowerCase()===MANIFEST)throw new Error(`This file cannot be included in a portable draft: ${name}`);
    if(portableNames.has(name.normalize('NFC').toLowerCase()))throw new Error(`File names collide on another platform: ${name}`);
    portableNames.add(name.normalize('NFC').toLowerCase());
    const info=await stat(source);if(!info.isFile())throw new Error(`Not a regular project file: ${name}`);
    total+=info.size;if(total>limit || entries.length>=MAX_FILES-1)throw new Error('The draft exceeds its configured size or file-count limit.');
    const dest=join(stage,name);await mkdir(dirname(dest),{recursive:true});await copyFile(source,dest);
    const checksum=await sha256(dest,signal);
    if((await stat(dest)).size!==info.size || checksum!==await sha256(source,signal))throw new Error(`File changed while packaging: ${name}`);
    manifest.files.push({path:name,size:info.size,sha256:checksum});entries.push({name,file:dest});
  }
  async function walk(dir,ancestors) {
    signal.throwIfAborted();
    const resolved=await realpath(dir?readable(root,dir):root);
    if(ancestors.has(resolved))throw new Error(`A linked directory forms a cycle: ${dir}`);
    const next=new Set(ancestors);next.add(resolved);
    for(const entry of await readdir(resolved,{withFileTypes:true})) {
      if(entry.name.startsWith('.') || /\.log$/i.test(entry.name) || SKIP.has(entry.name.normalize('NFC').toLowerCase()))continue;
      const name=dir?`${dir}/${entry.name}`:entry.name;
      const source=readable(root,name),info=await stat(source);
      if(info.isDirectory())await walk(name,next);else await stageSnapshotFile(name,source);
    }
  }
  try {
    await walk('',new Set());
    for(const name of STUDIO_STATE) {
      const source=join(root,name);const info=await lstat(source).catch(()=>null);if(!info)continue;
      const resolved=await realpath(source),back=relative(root,resolved);
      if(info.isSymbolicLink() || back.startsWith(`..${sep}`) || back==='..')throw new Error('Portable editor state must stay inside the project.');
      await stageSnapshotFile(name,source);
    }
    await verifyFilm(stage,new Set(manifest.files.map(f=>f.path)));
    entries.push({name:MANIFEST,data:Buffer.from(JSON.stringify(manifest))});
    await zipFiles(out,entries,signal);
    if((await stat(out)).size>limit)throw new Error('The packaged draft exceeds the configured limit.');
  } catch(error) {await rm(out,{force:true});throw error;}
  finally {await rm(stage,{recursive:true,force:true});}
}
export async function restoreSnapshot(archive,limit,signal) {
  const library=libraryRoot();await mkdir(library,{recursive:true});
  const stage=await mkdtemp(join(library,'.cloud-restore-'));let zip;
  try {
    zip=await new Promise((resolve,reject)=>yauzl.open(archive,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,value)=>error?reject(error):resolve(value)));
    const seen=new Set(),files=new Map();let total=0,count=0;
    await new Promise((resolve,reject)=>{
      zip.on('error',reject);zip.on('end',resolve);
      zip.on('entry',entry=>{void(async()=>{
        signal.throwIfAborted();const name=entry.fileName;
        const mode=(entry.externalFileAttributes>>>16)&0xf000;
        if(!safePath(name) || (!portable(name) && name!==MANIFEST) || (mode && mode!==0x8000) || seen.has(name.normalize('NFC').toLowerCase()))throw new Error('Unsafe, duplicate or nonportable entry in cloud draft.');
        seen.add(name.normalize('NFC').toLowerCase());total+=entry.uncompressedSize;count++;
        if(total>limit || count>MAX_FILES || (name===MANIFEST && entry.uncompressedSize>16*1024*1024))throw new Error('Draft extraction limit exceeded.');
        const dest=join(stage,name);await mkdir(dirname(dest),{recursive:true});
        const stream=await new Promise((resolve,reject)=>zip.openReadStream(entry,(error,value)=>error?reject(error):resolve(value)));
        const hash=createHash('sha256');let size=0;
        await pipeline(stream,new Transform({transform(chunk,encoding,done){size+=chunk.length;hash.update(chunk);done(null,chunk);}}),createWriteStream(dest,{flags:'wx',mode:0o600}),{signal});
        files.set(name,{size,sha256:hash.digest('hex')});zip.readEntry();
      })().catch(reject);});zip.readEntry();
    });
    const manifest=JSON.parse(await readFile(join(stage,MANIFEST),'utf8'));
    if(manifest.format!=='openfilm-cloud-snapshot' || manifest.version!==1 || !Array.isArray(manifest.files) || manifest.files.length!==files.size-1)throw new Error('Invalid cloud draft manifest.');
    const declared=new Set();
    for(const entry of manifest.files) {
      const actual=files.get(entry.path);
      if(entry.path===MANIFEST || declared.has(entry.path) || !actual || entry.size!==actual.size || entry.sha256!==actual.sha256)throw new Error('A draft file is missing or corrupt.');declared.add(entry.path);
    }
    await verifyFilm(stage,declared);await rm(join(stage,MANIFEST));signal.throwIfAborted();
    const destination=join(library,`restored-${randomUUID()}`);await rename(stage,destination);
    try {return {project:await openProject(destination,{create:false})};}
    catch(error){await rm(destination,{recursive:true,force:true});throw error;}
  } finally {zip?.close();await rm(stage,{recursive:true,force:true});}
}
