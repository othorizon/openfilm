import React from 'react';
import { createPortal } from 'react-dom';
import { X, Cloud } from 'lucide-react';
import { api, type CloudAccount, type CloudItem, type CloudTransfer, type Project } from '@/api';
import { useT } from '@/i18n';
import { ConfirmDialog } from './ConfirmDialog';
import { SettingsButton, SettingsField } from './settings/ui';

const field='rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-sm text-[var(--text)]';
const bytes=(n:number)=>{const unit=n>=1e9?3:n>=1e6?2:n>=1e3?1:0;return `${new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(n/1000**unit)} ${['B','KB','MB','GB'][unit]}`;};
type Tab='mine'|'public'|'snapshot'|'result'|'transfers';
export function CloudLibrary({projectId:initialProject}:{projectId?:string}) {
  const t=useT(),word=(key:string)=>t(`cloudLibrary.${key}`);
  const [account,setAccount]=React.useState<CloudAccount|null>(null),[projects,setProjects]=React.useState<Project[]>([]);
  const [projectId,setProjectId]=React.useState(initialProject??''),[tab,setTab]=React.useState<Tab>('mine');
  const [items,setItems]=React.useState<CloudItem[]>([]),[jobs,setJobs]=React.useState<CloudTransfer[]>([]);
  const [query,setQuery]=React.useState(''),[tag,setTag]=React.useState(''),[type,setType]=React.useState('');
  const [source,setSource]=React.useState(''),[tags,setTags]=React.useState(''),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const [next,setNext]=React.useState<number|null>(null),[preview,setPreview]=React.useState<{item:CloudItem;url:string}|null>(null);
  const [confirmation,setConfirmation]=React.useState<{title:string;description?:string;danger?:boolean;run:()=>Promise<unknown>}|null>(null);
  const generation=React.useRef(0);
  const filters=React.useCallback((offset=0)=>new URLSearchParams({scope:tab==='public'?'public':'mine',kind:tab==='snapshot'?'snapshot':tab==='result'?'result':'asset',q:query,tag,type,offset:String(offset),projectId:tab==='result'||tab==='snapshot'?projectId:''}).toString(),[tab,query,tag,type,projectId]);
  async function refresh(offset=0) {
    const version=++generation.current;setError('');
    try {
      const status=await api.cloud();if(version!==generation.current)return;setAccount(status);
      if(!status.user){setItems([]);setJobs([]);setPreview(null);return;}
      const [catalog,transfers]=await Promise.all([api.cloudItems(filters(offset)),api.cloudTransfers()]);
      if(version!==generation.current)return;
      setItems(old=>offset?[...old,...catalog.items]:catalog.items);setNext(catalog.nextOffset);setJobs(transfers.transfers);
    }catch(e){if(version===generation.current)setError(e instanceof Error?e.message:String(e));}
  }
  React.useEffect(()=>{void api.projects().then(setProjects).catch(e=>setError(e.message));},[]);
  React.useEffect(()=>{setPreview(null);const timeout=setTimeout(()=>void refresh(),150);return()=>{clearTimeout(timeout);generation.current++;};},[filters]);
  React.useEffect(()=>{

    let live=true;
    const timer=setInterval(()=>{void (async()=>{
      const status=await api.cloud();if(!live)return;
      if(status.user?.id!==account?.user?.id || status.serviceUrl!==account?.serviceUrl || status.offline) {
        generation.current++;setAccount(status);setItems([]);setJobs([]);setPreview(null);setNext(null);
        if(status.user&&!status.offline)void refresh();return;
      }
      setAccount(status);
      if(!status.user)return;
      const value=await api.cloudTransfers();if(live)setJobs(value.transfers);
    })().catch(e=>{if(live){setError(e.message);setPreview(null);setItems([]);}});},1500);
    return()=>{live=false;clearInterval(timer);};
  },[account?.user?.id,account?.serviceUrl,filters]);
  async function run(action:()=>Promise<unknown>) {
    setBusy(true);setError('');try{await action();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  function upload(snapshot=false) {
    setConfirmation({title:word(snapshot?'confirmSnapshot':'confirmUpload'),description:snapshot?projects.find(p=>p.id===projectId)?.name:source,
      run:async()=>{await api.cloudTransfer({direction:'upload',kind:snapshot?'snapshot':tab==='result'?'result':'asset',projectId,path:source,tags:tags.split(',').map(s=>s.trim()).filter(Boolean),confirmed:true});setTab('transfers');}});
  }
  function mutation(item:CloudItem,action:string) {
    if(action==='withdraw'){void run(()=>api.cloudAction(item.id,action));return;}
    setConfirmation({title:word(action==='delete'?'confirmDelete':'confirmShare'),description:action==='delete'?word('deleteHint'):item.name,danger:action==='delete',run:()=>api.cloudAction(item.id,action,true)});
  }
  return <section className="flex flex-col gap-4 text-[var(--text)]" aria-label={word('title')}>
    <p className="text-sm text-[var(--text-muted)]">{word('intro')}</p>
    {error?<p role="alert" className="text-sm text-red-500">{error}</p>:null}
    {!account?.user?<p role="status">{account?.notice??word('signIn')}</p>:<>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>{account.user.username} · {bytes(account.space?.usedBytes??0)} / {bytes(account.space?.quotaBytes??0)}</span>
        <span>{word('available')}: {bytes(Math.max(0,(account.space?.quotaBytes??0)-(account.space?.usedBytes??0)-(account.space?.reservedBytes??0)))}</span>
        {!!account.space?.reservedBytes&&<span>{word('reserved')}: {bytes(account.space.reservedBytes)}</span>}
        <SettingsButton disabled={busy} onClick={()=>void refresh()}>{word('refresh')}</SettingsButton>
      </div>
      <label className="flex items-center gap-3 text-sm">{word('project')}
        <select aria-label={word('project')} className={field} value={projectId} onChange={e=>setProjectId(e.target.value)}>
          <option value="">{word('chooseProject')}</option>{projects.filter(p=>!p.missing).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <nav className="flex flex-wrap gap-2" aria-label={word('title')}>{(['mine','public','snapshot','result','transfers'] as Tab[]).map(value=><SettingsButton key={value} variant={tab===value?'primary':undefined} onClick={()=>setTab(value)}>{word(value)}</SettingsButton>)}</nav>
      {tab==='transfers'?<TransferList jobs={jobs} busy={busy} onAction={(id,action)=>void run(()=>api.cloudTransferAction(id,action))}/>:<>
        <div className="flex flex-wrap gap-2">
          <SettingsField aria-label={word('search')} placeholder={word('search')} value={query} onChange={e=>setQuery(e.target.value)}/>
          <SettingsField aria-label={word('tag')} placeholder={word('tag')} value={tag} onChange={e=>setTag(e.target.value)}/>
          <select aria-label={word('type')} className={field} value={type} onChange={e=>setType(e.target.value)}><option value="">{word('type')}</option>{['image','video','audio'].map(v=><option key={v} value={v}>{word(v)}</option>)}</select>
        </div>
        {tab==='snapshot'?<SettingsButton disabled={busy||!projectId} onClick={()=>upload(true)}>{word('saveDraft')}</SettingsButton>:tab!=='public'?<div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
          <div className="flex gap-2"><SettingsField aria-label={word('source')} placeholder={word('source')} value={source} onChange={e=>setSource(e.target.value)}/><SettingsButton disabled={busy} onClick={()=>void run(async()=>{const chosen=await api.cloudPickFiles();if(chosen.paths[0])setSource(chosen.paths[0]);})}>{word('choose')}</SettingsButton></div>
          <SettingsField aria-label={word('tags')} placeholder={word('tags')} value={tags} onChange={e=>setTags(e.target.value)}/>
          <SettingsButton disabled={busy||!source||!projectId} onClick={()=>upload()}>{word('upload')}</SettingsButton>
        </div>:null}
        {preview?<div className="rounded-lg border border-[var(--border)] p-3">
          <div className="mb-2 flex justify-between"><span>{preview.item.name}</span><button aria-label={word('close')} onClick={()=>setPreview(null)}><X size={18}/></button></div>
          {preview.item.mediaType==='image'?<img className="max-h-72 max-w-full object-contain" src={preview.url} alt={preview.item.name}/>:preview.item.mediaType==='video'?<video className="max-h-72 w-full" src={preview.url} controls/>:<audio className="w-full" src={preview.url} controls/>}
        </div>:null}
        {!items.length?<p className="text-sm text-[var(--text-muted)]">{word('empty')}</p>:<div className="grid gap-3 sm:grid-cols-2">{items.map(item=><article key={item.id} className="rounded-lg border border-[var(--border)] p-3">
          <h3 className="truncate font-medium" title={item.name}>{item.name}</h3><p className="my-1 text-xs text-[var(--text-muted)]">{bytes(item.size)} · {word(item.withdrawn?'removed':item.visibility==='public'?'shared':'private')} · {new Date(item.createdAt).toLocaleString()}</p>
          <p className="mb-2 text-xs">{item.tags.join(' · ')}{item.projectId?` · ${projects.find(p=>p.id===item.projectId)?.name??item.projectId}`:''}</p>
          <div className="flex flex-wrap gap-2">
            {['image','video','audio'].includes(item.mediaType)?<SettingsButton disabled={busy} onClick={()=>void run(async()=>{const grant=await api.cloudAction(item.id,'download');if(grant.url)setPreview({item,url:grant.url});})}>{word('preview')}</SettingsButton>:null}
            <SettingsButton disabled={busy||(!projectId&&item.kind!=='snapshot')} onClick={()=>void run(async()=>{await api.cloudTransfer({direction:'download',itemId:item.id,projectId});setTab('transfers');})}>{word(item.kind==='snapshot'?'restore':'download')}</SettingsButton>
            {item.ownerId===account.user?.id?<>
              {item.kind==='asset'&&!item.withdrawn?<SettingsButton disabled={busy} onClick={()=>mutation(item,item.visibility==='public'?'withdraw':'publish')}>{word(item.visibility==='public'?'withdraw':'publish')}</SettingsButton>:null}
              {item.kind==='result'&&item.mediaType!=='other'?<SettingsButton disabled={busy} onClick={()=>mutation(item,'share')}>{word('share')}</SettingsButton>:null}
              <SettingsButton disabled={busy} onClick={()=>mutation(item,'delete')}>{word('delete')}</SettingsButton>
            </>:null}
          </div>
        </article>)}</div>}
        {next!==null?<SettingsButton disabled={busy} onClick={()=>void refresh(next)}>{word('more')}</SettingsButton>:null}
      </>}
    </>}
    <ConfirmDialog open={!!confirmation} title={confirmation?.title??''} description={confirmation?.description} danger={confirmation?.danger} onCancel={()=>setConfirmation(null)} onConfirm={()=>{const action=confirmation?.run;setConfirmation(null);if(action)void run(action);}}/>
  </section>;
}
export function CloudLibraryDialog({projectId,onClose}:{projectId:string;onClose:()=>void}) {
  const t=useT(),ref=React.useRef<HTMLDivElement>(null);
  React.useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;ref.current?.focus();
    const key=(e:KeyboardEvent)=>{
      if(e.key==='Escape' && ref.current?.contains(e.target as Node)){e.stopPropagation();onClose();}
      if(e.key==='Tab' && ref.current?.contains(document.activeElement)) {
        const nodes=Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]'));
        const first=nodes[0],last=nodes[nodes.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    };window.addEventListener('keydown',key);return()=>{window.removeEventListener('keydown',key);previous?.focus();};
  },[onClose]);
  return createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-5" onClick={onClose}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('cloudLibrary.title')} onClick={e=>e.stopPropagation()} className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl bg-[var(--bg)] p-6 text-[var(--text)] shadow-2xl">
      <header className="mb-5 flex items-center justify-between"><h2 className="flex items-center gap-2 text-lg font-semibold"><Cloud size={20}/>{t('cloudLibrary.title')}</h2><button aria-label={t('cloudLibrary.close')} onClick={onClose}><X/></button></header>
      <CloudLibrary projectId={projectId}/>
    </div>
  </div>,document.body);
}

function TransferList({jobs,busy,onAction}:{jobs:CloudTransfer[];busy:boolean;onAction:(id:string,action:string)=>void}) {
  const t=useT(),word=(key:string)=>t(`cloudLibrary.${key}`);
  return <div className="flex flex-col gap-3">
        {!jobs.length?<p>{word('noTransfers')}</p>:jobs.map(job=><article key={job.id} className="rounded-lg border border-[var(--border)] p-3">
          <div className="flex justify-between gap-3"><strong className="truncate text-sm">{job.name??job.id}</strong><span className="text-sm">{word(job.state)}</span></div>
          <progress aria-label={job.name??job.id} className="my-2 w-full" max={job.size??1} value={job.progress}/>
          <p className="text-xs">{bytes(job.progress)} / {bytes(job.size??0)}</p>
          {job.error?<p className="my-2 text-sm text-red-500">{job.error}</p>:null}
          {job.result?.path?<p className="my-2 break-all text-sm">{job.result.path}</p>:null}
          {job.result?.project?<a className="text-sm underline" href={`/projects/${job.result.project.id}`}>{word('openProject')}</a>:null}
          <div className="mt-2 flex gap-2">{(['running','queued'].includes(job.state)?['pause','cancel']:['error','paused'].includes(job.state)?['resume','cancel']:[]).map(action=><SettingsButton key={action} disabled={busy} onClick={()=>onAction(job.id,action)}>{word(action)}</SettingsButton>)}</div>
        </article>)}
      </div>;
}
