import { api, type CloudAccount, type CloudItem } from '../api';
import type { CloudResourceRef, ResourceDragItem } from './resource-drag';
import { factsOfProbe, resourceKindOf, type WorkspaceResource } from './workspace-resources';

export function cloudResource(item: CloudItem, account: CloudAccount, url?: string): WorkspaceResource {
  if (!account.user || !account.serviceUrl) throw new Error('Sign in to use cloud media.');
  return {
    path: `cloud/${item.id}/${item.name}`,
    name: item.name,
    dir: '',
    size: item.size,
    kind: ['image', 'video', 'audio'].includes(item.mediaType) ? (item.mediaType as WorkspaceResource['kind']) : 'other',
    mtimeMs: Date.parse(item.createdAt),
    cloud: { id: item.id, accountId: account.user.id, serviceUrl: account.serviceUrl },
    ...(url ? { cloudPreviewUrl: url } : {}),
  };
}

export function sameCloudAccount(ref: CloudResourceRef, account: CloudAccount): boolean {
  return !account.offline && ref.accountId === account.user?.id && ref.serviceUrl === account.serviceUrl;
}

/** Download and verify first, then hand the editor an ordinary project-relative resource. */
export async function importCloudMedia(projectId: string, file: ResourceDragItem, signal?: AbortSignal): Promise<WorkspaceResource> {
  const ref = file.cloud;
  if (!ref) throw new Error('Choose cloud media.');
  signal?.throwIfAborted();
  if (!sameCloudAccount(ref, await api.cloud())) throw new Error('The cloud account changed. Select the media again.');
  const { transfer } = await api.cloudTransfer({
    direction: 'download',
    projectId,
    itemId: ref.id,
    accountId: ref.accountId,
    serviceUrl: ref.serviceUrl,
  });
  for (;;) {
    signal?.throwIfAborted();
    const { transfers } = await api.cloudTransfers();
    const job = transfers.find((j) => j.id === transfer.id && j.ownerId === ref.accountId && j.serviceUrl === ref.serviceUrl);
    if (!job) throw new Error('The cloud account changed. Select the media again.');
    if (['paused', 'cancelled', 'error'].includes(job.state))
      throw new Error(job.error || 'Download paused. Continue it in Transfers, then add the local file.');
    if (job.state === 'completed') {
      const path = job.result?.path;
      if (!path || !path.startsWith('assets/')) throw new Error('The download did not produce a local media file.');
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/media?what=probe&path=${encodeURIComponent(path)}`);
      const probe = response.ok ? await response.json() : null;
      signal?.throwIfAborted();
      return {
        path,
        name: path.split('/').pop()!,
        kind: resourceKindOf(path),
        dir: '',
        size: job.size ?? 0,
        mtimeMs: Date.now(),
        ...factsOfProbe(probe),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
