import React from 'react';
import {
  Cloud,
  HardDrive,
  Users,
  Upload,
  Search,
  RefreshCw,
  ArrowDownUp,
  Plus,
  Music2,
  Film,
  Image as ImageIcon,
  FileArchive,
  MoreHorizontal,
  LayoutGrid,
  List,
  Check,
  Loader2,
} from 'lucide-react';
import { api, type CloudAccount, type CloudItem, type CloudTransfer } from '@/api';
import { useT } from '@/i18n';
import { studioHost } from '@/lib/host';
import { cloudResource, sameCloudAccount } from '@/lib/cloud-media';
import { clearResourceDrag, isComputerFileDrag, setResourceDragData } from '@/lib/resource-drag';
import type { WorkspaceResource } from '@/lib/workspace-resources';
import type { MediaPoolProps } from './MediaPool';
import { useNearViewport } from './MediaPreview';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { CardButton } from './Card';
import { CloudUploadDialog, cloudField, type CloudUploadFile } from './CloudUploadDialog';

type Tab = 'local' | 'shared' | 'mine';
type Props = Pick<MediaPoolProps, 'projectId' | 'onImport' | 'onPick'> & {
  children: React.ReactNode;
  selectedPath?: string | null;
  reveal?: number;
  onSelect: (file: WorkspaceResource | null) => void;
  onAdd: (file: WorkspaceResource) => void;
  onSettings: () => void;
};
const bytes = (n: number) => {
  const unit = n >= 1e9 ? 3 : n >= 1e6 ? 2 : n >= 1e3 ? 1 : 0;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n / 1000 ** unit)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
};
const button =
  'flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline focus-visible:outline-1 disabled:opacity-40';

/** The editor's one media pane. Local folders retain their state while browsing the cloud. */
export function MediaLibrary(props: Props) {
  const t = useT();
  const [tab, setTab] = React.useState<Tab>('local');
  React.useEffect(() => {
    if (props.reveal) setTab('local');
  }, [props.reveal]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label={t('mediaCloud.library')} className="flex shrink-0 gap-0.5 border-b border-[var(--border)] px-2 pt-1">
        {(
          [
            { id: 'local', Icon: HardDrive },
            { id: 'shared', Icon: Users },
            { id: 'mine', Icon: Cloud },
          ] as const
        ).map(({ id, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`media-library-${id}`}
            id={`media-tab-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const tabs: Tab[] = ['local', 'shared', 'mine'];
              const next =
                e.key === 'Home' ? 'local' : e.key === 'End' ? 'mine' : tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
              setTab(next);
              document.getElementById(`media-tab-${next}`)?.focus();
            }}
            className={`flex min-w-0 items-center justify-center gap-1.5 border-b-2 px-2 py-2 text-[12px] transition ${
              tab === id
                ? 'border-[var(--text)] text-[var(--text)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            <Icon size={13} className="shrink-0" />
            <span className="truncate">{t(`mediaCloud.${id}`)}</span>
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="media-library-local"
        aria-labelledby="media-tab-local"
        hidden={tab !== 'local'}
        className={tab === 'local' ? 'min-h-0 flex-1' : 'hidden'}
      >
        {props.children}
      </div>
      {tab !== 'local' ? (
        <div role="tabpanel" id={`media-library-${tab}`} aria-labelledby={`media-tab-${tab}`} className="min-h-0 flex-1">
          <CloudMediaPool key={tab} {...props} tab={tab} />
        </div>
      ) : null}
    </div>
  );
}

function CloudMediaPool({
  tab,
  projectId,
  onImport,
  onPick,
  onSelect,
  onAdd,
  onSettings,
  selectedPath,
}: Props & { tab: Exclude<Tab, 'local'> }) {
  const t = useT(),
    word = (key: string) => t(`cloudLibrary.${key}`);
  const [account, setAccount] = React.useState<CloudAccount | null>(null);
  const [items, setItems] = React.useState<CloudItem[]>([]),
    [jobs, setJobs] = React.useState<CloudTransfer[]>([]);
  const [query, setQuery] = React.useState(''),
    [tag, setTag] = React.useState(''),
    [type, setType] = React.useState('');
  const [kind, setKind] = React.useState('asset'),
    [rows, setRows] = React.useState(false),
    [transfers, setTransfers] = React.useState(false);
  const [loading, setLoading] = React.useState(true),
    [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState('');
  const [next, setNext] = React.useState<number | null>(null),
    [dragging, setDragging] = React.useState(false);
  const [upload, setUpload] = React.useState<CloudUploadFile[] | null>(null);
  const [confirmation, setConfirmation] = React.useState<{
    title: string;
    description?: string;
    danger?: boolean;
    run: () => Promise<unknown>;
  } | null>(null);
  const version = React.useRef(0),
    live = React.useRef(true),
    identity = React.useRef('');
  const input = React.useRef<HTMLInputElement>(null),
    depth = React.useRef(0),
    previewVersion = React.useRef(0);
  const queued = React.useRef(new Set<CloudUploadFile>());
  const jobsRef = React.useRef(jobs);
  jobsRef.current = jobs;
  const filters = React.useMemo(
    () => new URLSearchParams({ scope: tab === 'shared' ? 'public' : 'mine', kind, q: query, tag, type }).toString(),
    [tab, kind, query, tag, type]
  );
  const acceptAccount = React.useCallback(
    (status: CloudAccount) => {
      const key = status.user && !status.offline ? `${status.serviceUrl}:${status.user.id}` : '';
      if (identity.current !== key) {
        identity.current = key;
        previewVersion.current++;
        setItems([]);
        setJobs([]);
        setUpload(null);
        setConfirmation(null);
        setNext(null);
        onSelect(null);
      }
      setAccount(status);
      return key;
    },
    [onSelect]
  );
  const refresh = React.useCallback(
    async (offset = 0) => {
      const request = ++version.current;
      setLoading(true);
      setError('');
      try {
        const status = await api.cloud();
        if (!live.current || request !== version.current) return;
        const key = acceptAccount(status);
        if (!key) return;
        const [catalog, result] = await Promise.all([api.cloudItems(`${filters}&offset=${offset}`), api.cloudTransfers()]);
        if (!live.current || request !== version.current || identity.current !== key) return;
        setItems((old) => (offset ? [...old, ...catalog.items] : catalog.items));
        setNext(catalog.nextOffset);
        setJobs(result.transfers);
      } catch (e) {
        if (live.current && request === version.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live.current && request === version.current) setLoading(false);
      }
    },
    [filters, acceptAccount]
  );
  React.useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      version.current++;
      previewVersion.current++;
    };
  }, []);
  React.useEffect(() => {
    setItems([]);
    setNext(null);
    const timer = setTimeout(() => void refresh(), 180);
    return () => {
      clearTimeout(timer);
      version.current++;
    };
  }, [refresh]);
  React.useEffect(() => {
    let stopped = false,
      polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void (async () => {
        const status = await api.cloud();
        if (stopped) return;
        const previous = identity.current,
          key = acceptAccount(status);
        if (key !== previous) {
          version.current++;
          if (key) void refresh();
          return;
        }
        if (!key) return;
        const result = await api.cloudTransfers();
        if (stopped || identity.current !== key) return;
        const completed = result.transfers.some(
          (job) => job.state === 'completed' && jobsRef.current.find((v) => v.id === job.id)?.state !== 'completed'
        );
        setJobs(result.transfers);
        if (completed) void refresh();
      })()
        .catch((e) => {
          if (!stopped) setError(e.message);
        })
        .finally(() => {
          polling = false;
        });
    }, 1800);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [acceptAccount, refresh]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      if (live.current) await refresh();
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  function prepare(files: CloudUploadFile[]) {
    queued.current.clear();
    setUpload(files);
    setDragging(false);
    depth.current = 0;
  }
  function fromFiles(files: File[]) {
    if (files.length)
      prepare(files.map((file) => ({ file, path: studioHost?.folders?.pathOf(file) || undefined, name: file.name, tags: '' })));
  }
  async function pick() {
    const paths = await onPick?.(word('choose'), false);
    if (paths && paths !== 'no-dialog') {
      if (paths.length) prepare(paths.map((path) => ({ path, name: path.split(/[/\\]/).pop()!, tags: '' })));
    } else input.current?.click();
  }
  async function uploadFiles(files: CloudUploadFile[], done: (index: number) => void) {
    if (!account?.user || !account.serviceUrl) throw new Error(word('signIn'));
    const binding = { accountId: account.user.id, serviceUrl: account.serviceUrl };
    for (const [index, entry] of files.entries()) {
      if (queued.current.has(files[index])) {
        done(index);
        continue;
      }
      if (!sameCloudAccount({ ...binding, id: '' }, await api.cloud())) throw new Error(t('mediaCloud.accountChanged'));
      let path = entry.path;
      if (!path && entry.file) {
        let landed: string | undefined;
        const result = await onImport([entry.file], 'assets', (_index, _ratio, value) => {
          if (value) landed = value;
        });
        path = Array.isArray(result) ? result[0] : landed;
      }
      if (!path) throw new Error(t('mediaCloud.importFailed'));
      await api.cloudTransfer({
        direction: 'upload',
        kind: kind === 'result' ? 'result' : 'asset',
        projectId,
        path,
        name: entry.name.trim(),
        tags: entry.tags
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
        confirmed: true,
        ...binding,
      });
      queued.current.add(entry);
      done(index);
    }
    setTransfers(true);
    await refresh();
  }
  function mutate(item: CloudItem, action: string) {
    setConfirmation({
      title: word(action === 'delete' ? 'confirmDelete' : action === 'withdraw' ? 'withdraw' : 'confirmShare'),
      description: action === 'delete' ? word('deleteHint') : item.name,
      danger: action === 'delete',
      run: () => api.cloudAction(item.id, action, true),
    });
  }
  async function select(item: CloudItem) {
    if (!account?.user) return;
    const request = ++previewVersion.current,
      ref = cloudResource(item, account).cloud!;
    try {
      const grant = await api.cloudAction(item.id, 'download');
      const current = await api.cloud();
      if (live.current && request === previewVersion.current && sameCloudAccount(ref, current) && grant.url)
        onSelect(cloudResource(item, account, grant.url));
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    }
  }
  const ready = !!account?.user && !account.offline;
  const active = jobs.filter((job) => ['queued', 'running'].includes(job.state)).length;
  return (
    <section
      aria-label={t(`mediaCloud.${tab}`)}
      className="relative flex h-full min-h-0 flex-col text-[var(--text)]"
      onDragEnter={(e) => {
        if (tab === 'mine' && ready && kind !== 'snapshot' && isComputerFileDrag(e.dataTransfer)) {
          e.preventDefault();
          depth.current++;
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (isComputerFileDrag(e.dataTransfer) && --depth.current <= 0) {
          depth.current = 0;
          setDragging(false);
        }
      }}
      onDragOver={(e) => {
        if (isComputerFileDrag(e.dataTransfer)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = tab === 'mine' && ready && kind !== 'snapshot' ? 'copy' : 'none';
        }
      }}
      onDrop={(e) => {
        if (!isComputerFileDrag(e.dataTransfer)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (tab === 'mine' && ready && kind !== 'snapshot') fromFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-[var(--bg-hover)] px-2">
          <Search size={13} className="shrink-0 text-[var(--text-faint)]" />
          <input
            aria-label={word('search')}
            placeholder={word('search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 min-w-0 w-full bg-transparent text-[12px] outline-none"
          />
        </label>
        {tab === 'mine' && kind !== 'snapshot' ? (
          <button
            className={button}
            title={word('upload')}
            aria-label={word('upload')}
            disabled={!ready || busy}
            onClick={() => void run(pick)}
          >
            <Upload size={14} />
          </button>
        ) : null}
        <button
          className={button}
          title={t(rows ? 'media.viewGrid' : 'media.viewList')}
          aria-label={t(rows ? 'media.viewGrid' : 'media.viewList')}
          onClick={() => setRows(!rows)}
        >
          {rows ? <LayoutGrid size={14} /> : <List size={14} />}
        </button>
        <button className={button} title={word('refresh')} aria-label={word('refresh')} disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          className={`${button} ${transfers ? 'bg-[var(--bg-active)]' : ''}`}
          title={word('transfers')}
          aria-label={word('transfers')}
          aria-pressed={transfers}
          onClick={() => setTransfers(!transfers)}
        >
          <ArrowDownUp size={14} />
          {active ? <span className="text-[10px]">{active}</span> : null}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          className="hidden"
          onChange={(e) => {
            fromFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      {ready ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 pb-2">
            {tab === 'mine' ? (
              <select
                aria-label={t('mediaCloud.contents')}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setTransfers(false);
                }}
                className={`${cloudField} flex-1`}
              >
                <option value="asset">{word('mine')}</option>
                <option value="snapshot">{word('snapshot')}</option>
                <option value="result">{word('result')}</option>
              </select>
            ) : null}
            <select aria-label={word('type')} value={type} onChange={(e) => setType(e.target.value)} className={`${cloudField} flex-1`}>
              <option value="">{word('type')}</option>
              {['video', 'image', 'audio'].map((value) => (
                <option key={value} value={value}>
                  {word(value)}
                </option>
              ))}
            </select>
            <input
              aria-label={word('tag')}
              placeholder={word('tag')}
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className={`${cloudField} w-24 flex-1`}
            />
          </div>
          {tab === 'mine' ? (
            <div className="flex shrink-0 items-center gap-2 px-2.5 pb-2 text-[10px] text-[var(--text-faint)]">
              <span className="truncate">{account.user!.username}</span>
              <span className="ml-auto whitespace-nowrap">
                {bytes(account.space?.usedBytes ?? 0)} / {bytes(account.space?.quotaBytes ?? 0)}
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="shrink-0 px-3 py-2 text-[12px] text-[var(--err)]">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3" aria-busy={loading}>
        {!ready ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-5 text-center">
            <Cloud size={28} strokeWidth={1} className="text-[var(--text-faint)]" />
            <p className="text-[12px] text-[var(--text-muted)]">{loading ? t('mediaCloud.loading') : account?.notice ?? word('signIn')}</p>
            <CardButton onClick={onSettings}>{t('settings.sections.cloud')}</CardButton>
          </div>
        ) : transfers ? (
          <CloudTransfers jobs={jobs} busy={busy} onAction={(id, action) => void run(() => api.cloudTransferAction(id, action))} />
        ) : (
          <>
            {kind === 'snapshot' ? (
              <CardButton
                className="mb-3"
                disabled={busy}
                onClick={() =>
                  setConfirmation({
                    title: word('confirmSnapshot'),
                    run: () =>
                      api.cloudTransfer({
                        direction: 'upload',
                        kind: 'snapshot',
                        projectId,
                        confirmed: true,
                        accountId: account.user!.id,
                        serviceUrl: account.serviceUrl,
                      }),
                  })
                }
              >
                {word('saveDraft')}
              </CardButton>
            ) : null}
            {!items.length ? (
              <div className="flex min-h-40 flex-col items-center justify-center gap-3 p-4 text-center">
                <Cloud size={28} strokeWidth={1} className="text-[var(--text-faint)]" />
                <p className="text-[12px] text-[var(--text-muted)]">{loading ? t('mediaCloud.loading') : word('empty')}</p>
                {tab === 'mine' && kind !== 'snapshot' ? (
                  <>
                    <p className="text-[11px] text-[var(--text-faint)]">{t('mediaCloud.dropHint')}</p>
                    <CardButton disabled={busy} onClick={() => void run(pick)}>
                      <Upload size={13} />
                      {word('upload')}
                    </CardButton>
                  </>
                ) : null}
              </div>
            ) : (
              <div
                className={rows ? 'flex flex-col gap-1' : 'grid gap-x-2 gap-y-2.5'}
                style={rows ? undefined : { gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))' }}
              >
                {items.map((item) => (
                  <CloudTile
                    key={`${identity.current}:${item.id}`}
                    item={item}
                    account={account}
                    rows={rows}
                    selected={selectedPath === `cloud/${item.id}/${item.name}`}
                    onSelect={() => void select(item)}
                    onAdd={() => onAdd(cloudResource(item, account))}
                    onMutation={(action) => mutate(item, action)}
                    onDownload={() =>
                      void run(async () => {
                        await api.cloudTransfer({
                          direction: 'download',
                          itemId: item.id,
                          projectId,
                          accountId: account.user!.id,
                          serviceUrl: account.serviceUrl,
                        });
                        setTransfers(true);
                      })
                    }
                  />
                ))}
              </div>
            )}
            {next !== null ? (
              <CardButton disabled={loading} className="mt-3" onClick={() => void refresh(next)}>
                {word('more')}
              </CardButton>
            ) : null}
          </>
        )}
      </div>
      {tab === 'mine' && ready && !transfers && kind !== 'snapshot' && items.length ? (
        <p className="shrink-0 border-t border-[var(--border)] px-3 py-2 text-[10px] text-[var(--text-faint)]">
          {t('mediaCloud.dropHint')}
        </p>
      ) : null}
      {dragging ? (
        <div className="pointer-events-none absolute inset-1 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-[var(--text-muted)] bg-[var(--panel)]/95 text-[12px]">
          <Upload size={26} />
          {t('mediaCloud.dropUpload')}
        </div>
      ) : null}
      {upload ? <CloudUploadDialog files={upload} onClose={() => setUpload(null)} onUpload={uploadFiles} /> : null}
      <ConfirmDialog
        open={!!confirmation}
        title={confirmation?.title ?? ''}
        description={confirmation?.description}
        danger={confirmation?.danger}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          const action = confirmation?.run;
          setConfirmation(null);
          if (action) void run(action);
        }}
      />
    </section>
  );
}

function CloudTile({
  item,
  account,
  rows,
  selected,
  onSelect,
  onAdd,
  onMutation,
  onDownload,
}: {
  item: CloudItem;
  account: CloudAccount;
  rows: boolean;
  selected: boolean;
  onSelect: () => void;
  onAdd: () => void;
  onMutation: (action: string) => void;
  onDownload: () => void;
}) {
  const t = useT(),
    [ref, near] = useNearViewport<HTMLDivElement>();
  const [url, setUrl] = React.useState(''),
    [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null),
    [failed, setFailed] = React.useState(false);
  const media = ['image', 'video', 'audio'].includes(item.mediaType);
  React.useEffect(() => {
    if (!near || !['image', 'video'].includes(item.mediaType)) return;
    let live = true;
    void api
      .cloudAction(item.id, 'download')
      .then((grant) => {
        if (live && grant.url) setUrl(grant.url);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [near, item.id, item.mediaType]);
  const actions: ContextMenuEntry[] = [
    { id: 'download', label: t(`cloudLibrary.${item.kind === 'snapshot' ? 'restore' : 'download'}`), onSelect: onDownload },
  ];
  if (item.ownerId === account.user?.id) {
    const mutations =
      item.kind === 'asset' && !item.withdrawn
        ? [item.visibility === 'public' ? 'withdraw' : 'publish']
        : item.kind === 'result' && media
        ? ['share']
        : [];
    actions.push(
      ...mutations
        .concat('delete')
        .map((action) => ({
          id: action,
          label: t(`cloudLibrary.${action}`),
          danger: action === 'delete',
          onSelect: () => onMutation(action),
        }))
    );
  }
  const Icon =
    item.mediaType === 'audio' ? Music2 : item.mediaType === 'video' ? Film : item.mediaType === 'image' ? ImageIcon : FileArchive;
  return (
    <div
      ref={ref}
      data-cloud-item={item.id}
      className={`group relative min-w-0 rounded-md outline-none ${selected ? 'bg-[var(--bg-active)]' : 'hover:bg-[var(--bg-hover)]'} ${
        rows ? 'flex items-center gap-2 p-1' : 'p-1'
      }`}
      tabIndex={0}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      aria-label={item.name}
      draggable={media}
      onClick={media ? onSelect : undefined}
      onDoubleClick={media ? onAdd : undefined}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' && media) {
          e.preventDefault();
          onAdd();
        }
        if (e.key === ' ' && media) {
          e.preventDefault();
          onSelect();
        }
      }}
      onDragStart={(e) => {
        if (!media) return;
        setResourceDragData(e.dataTransfer, cloudResource(item, account));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDragEnd={clearResourceDrag}
    >
      <div
        className={`relative flex items-center justify-center overflow-hidden rounded-md bg-black/15 ring-1 ring-inset ${
          selected ? 'ring-[var(--text-muted)]' : 'ring-[var(--border)]'
        } ${rows ? 'h-10 w-16 shrink-0' : 'aspect-video w-full'}`}
      >
        {url && !failed && item.mediaType === 'image' ? (
          <img
            src={url}
            alt={item.name}
            draggable={false}
            loading="lazy"
            className="h-full w-full object-contain"
            onError={() => setFailed(true)}
          />
        ) : url && !failed && item.mediaType === 'video' ? (
          <video
            src={url}
            muted
            playsInline
            preload="metadata"
            className="pointer-events-none h-full w-full object-contain"
            onError={() => setFailed(true)}
          />
        ) : (
          <Icon size={rows ? 18 : 24} strokeWidth={1.25} className="text-[var(--text-faint)]" />
        )}
        {selected ? <Check size={12} className="absolute left-1 top-1 rounded bg-black/50 text-white" /> : null}
        {media ? (
          <button
            className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
            title={t('mediaCloud.add')}
            aria-label={`${t('mediaCloud.add')}: ${item.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            <Plus size={13} />
          </button>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className={`min-w-0 flex-1 truncate text-[12px] ${rows ? '' : 'pt-1.5'}`} title={item.name}>
            {item.name}
          </span>
          <button
            className="flex h-6 w-5 shrink-0 items-center justify-center text-[var(--text-faint)] hover:text-[var(--text)]"
            aria-label={`${t('mediaCloud.actions')}: ${item.name}`}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu(menu ? null : { x: rect.right, y: rect.bottom });
            }}
          >
            <MoreHorizontal size={13} />
          </button>
        </div>
        <p className="truncate text-[10px] text-[var(--text-faint)]">
          {bytes(item.size)} · {t(`cloudLibrary.${item.withdrawn ? 'removed' : item.visibility === 'public' ? 'shared' : 'private'}`)}
        </p>
        {item.tags.length ? (
          <p className="truncate text-[10px] text-[var(--text-muted)]" title={item.tags.join(' · ')}>
            {item.tags.join(' · ')}
          </p>
        ) : null}
      </div>
      {menu ? <ContextMenu {...menu} align="end" dense items={actions} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

function CloudTransfers({
  jobs,
  busy,
  onAction,
}: {
  jobs: CloudTransfer[];
  busy: boolean;
  onAction: (id: string, action: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2 pt-1">
      {!jobs.length ? (
        <p className="p-3 text-[12px] text-[var(--text-muted)]">{t('cloudLibrary.noTransfers')}</p>
      ) : (
        jobs.map((job) => (
          <article key={job.id} className="rounded-lg border border-[var(--border)] p-2.5">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate">{job.name ?? job.id}</span>
              {['queued', 'running'].includes(job.state) ? <Loader2 size={12} className="animate-spin" /> : null}
              <span className="text-[11px] text-[var(--text-muted)]">{t(`cloudLibrary.${job.state}`)}</span>
            </div>
            <progress
              aria-label={job.name ?? job.id}
              className="my-1 h-1 w-full accent-[var(--text-muted)]"
              max={job.size || 1}
              value={job.progress}
            />
            <p className="text-[10px] text-[var(--text-faint)]">
              {bytes(job.progress)} / {bytes(job.size ?? 0)}
            </p>
            {job.error ? <p className="mt-1 break-words text-[11px] text-[var(--err)]">{job.error}</p> : null}
            {job.result?.path ? (
              <p className="mt-1 truncate text-[10px] text-[var(--text-faint)]" title={job.result.path}>
                {job.result.path}
              </p>
            ) : null}
            {job.result?.project ? (
              <a className="text-[12px] underline" href={`/projects/${job.result.project.id}`}>
                {t('cloudLibrary.openProject')}
              </a>
            ) : null}
            <div className="mt-1 flex gap-1">
              {(['running', 'queued'].includes(job.state)
                ? ['pause', 'cancel']
                : ['error', 'paused'].includes(job.state)
                ? ['resume', 'cancel']
                : []
              ).map((action) => (
                <CardButton key={action} weight="quiet" disabled={busy} onClick={() => onAction(job.id, action)}>
                  {t(`cloudLibrary.${action}`)}
                </CardButton>
              ))}
            </div>
          </article>
        ))
      )}
    </div>
  );
}
