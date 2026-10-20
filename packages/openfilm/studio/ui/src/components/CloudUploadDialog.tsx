import React from 'react';
import { createPortal } from 'react-dom';
import { Upload } from 'lucide-react';
import { useT } from '@/i18n';
import { Card, CardActions, CardButton } from './Card';

export interface CloudUploadFile {
  file?: File;
  path?: string;
  name: string;
  tags: string;
}
export const cloudField =
  'min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[12px] text-[var(--text)] outline-none focus:border-[var(--text-muted)]';
export function CloudUploadDialog({
  files,
  onClose,
  onUpload,
}: {
  files: CloudUploadFile[];
  onClose: () => void;
  onUpload: (files: CloudUploadFile[], done: (index: number) => void) => Promise<void>;
}) {
  const t = useT();
  const [entries, setEntries] = React.useState(files);
  const [done, setDone] = React.useState<number[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => previous?.focus();
  }, []);
  const valid = entries.every(
    (entry, index) =>
      done.includes(index) ||
      (entry.name.trim() &&
        !/[/\\:\x00-\x1f]/.test(entry.name) &&
        entry.tags.split(/[,，]/).filter((s) => s.trim()).length <= 20 &&
        entry.tags.split(/[,，]/).every((s) => s.trim().length <= 40))
  );
  return createPortal(
    <div
      className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/45 p-5 backdrop-blur-[2px]"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={t('mediaCloud.uploadTitle')}
        className="w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && !busy) onClose();
          if (e.key === 'Tab') {
            const nodes = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])];
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <Card
          icon={<Upload size={16} />}
          title={t('mediaCloud.uploadTitle')}
          body={t('mediaCloud.privateHint')}
          onClose={busy ? undefined : onClose}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid || busy) return;
              setBusy(true);
              setError('');
              void onUpload(entries, (index) => setDone((old) => [...old, index]))
                .then(onClose)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <div className="mt-4 flex max-h-[55vh] flex-col gap-4 overflow-auto">
              {entries.map((entry, index) => (
                <fieldset key={index} disabled={busy || done.includes(index)} className="flex min-w-0 flex-col gap-2 disabled:opacity-50">
                  <p className="truncate text-[11px] text-[var(--text-faint)]">
                    {entry.file?.name ?? entry.path?.split(/[/\\]/).pop()}
                    {done.includes(index) ? ` · ${t('mediaCloud.queued')}` : ''}
                  </p>
                  <label className="flex flex-col gap-1 text-[12px] text-[var(--text-muted)]">
                    {t('mediaCloud.name')}
                    <input
                      className={cloudField}
                      value={entry.name}
                      required
                      maxLength={180}
                      onChange={(e) => setEntries((old) => old.map((v, i) => (i === index ? { ...v, name: e.target.value } : v)))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-[var(--text-muted)]">
                    {t('mediaCloud.tags')}
                    <input
                      className={cloudField}
                      value={entry.tags}
                      placeholder={t('mediaCloud.tagsHint')}
                      onChange={(e) => setEntries((old) => old.map((v, i) => (i === index ? { ...v, tags: e.target.value } : v)))}
                    />
                  </label>
                </fieldset>
              ))}
            </div>
            {error ? (
              <p role="alert" className="mt-3 text-[12px] text-[var(--err)]">
                {error}
              </p>
            ) : null}
            <CardActions>
              <CardButton weight="quiet" disabled={busy} onClick={onClose}>
                {t('project.close')}
              </CardButton>
              <CardButton type="submit" weight="primary" disabled={busy || !valid}>
                {t(busy ? 'mediaCloud.uploading' : 'cloudLibrary.upload')}
              </CardButton>
            </CardActions>
          </form>
        </Card>
      </div>
    </div>,
    document.body
  );
}
