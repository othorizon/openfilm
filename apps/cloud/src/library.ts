import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, readJson } from './http.ts';
import { Storage, type StorageConfig } from './storage.ts';

export type Limits = { quotaBytes: number; fileBytes: number; snapshotBytes: number; partBytes: number; uploadSeconds: number; cleanupSeconds: number };
export const defaultLimits: Limits = { quotaBytes: 10_000_000_000, fileBytes: 2_000_000_000, snapshotBytes: 5_000_000_000, partBytes: 8 * 1024 * 1024, uploadSeconds: 86400, cleanupSeconds: 300 };
const uuid = (s: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
const itemColumns = 'i.id,i.owner_id AS "ownerId",i.kind,i.name,i.media_type AS "mediaType",i.content_type AS "contentType",i.tags,i.project_id AS "projectId",i.visibility,i.withdrawn,i.created_at AS "createdAt",b.size::float8 AS size,b.sha256,b.etag';
const types: Record<string, [string, string]> = {
  png: ['image','image/png'], jpg: ['image','image/jpeg'], jpeg: ['image','image/jpeg'], webp: ['image','image/webp'], gif: ['image','image/gif'], avif: ['image','image/avif'],
  mp4: ['video','video/mp4'], mov: ['video','video/quicktime'], webm: ['video','video/webm'], mkv: ['video','video/x-matroska'], m4v: ['video','video/mp4'],
  mp3: ['audio','audio/mpeg'], wav: ['audio','audio/wav'], m4a: ['audio','audio/mp4'], aac: ['audio','audio/aac'], ogg: ['audio','audio/ogg'], flac: ['audio','audio/flac'],
};
type Owner = { id: string; username: string };
type Metadata = { kind: string; name: string; mediaType: string; contentType: string; tags: string[]; projectId: string | null; sha256: string; md5: string };
function metadata(body: Record<string, any>, limits: Limits): Metadata {
  if (!['asset','snapshot','result'].includes(body.kind) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 || /[/\\:\x00-\x1f]/.test(body.name)) throw new HttpError(400, 'Choose a content kind and a plain file name.');
  if (!Number.isSafeInteger(body.size) || body.size <= 0 || body.size > (body.kind === 'snapshot' ? limits.snapshotBytes : limits.fileBytes)) throw new HttpError(413, 'The file exceeds the configured size limit.');
  if (!/^[a-f0-9]{64}$/.test(body.sha256 ?? '') || !/^[A-Za-z0-9+/]{22}==$/.test(body.md5 ?? '')) throw new HttpError(400, 'Provide SHA-256 and MD5 checksums.');
  const [mediaType, contentType] = types[(body.name.split('.').pop() ?? '').toLowerCase()] ?? ['other','application/octet-stream'];
  if (body.kind === 'asset' && mediaType === 'other') throw new HttpError(400, 'Cloud assets must be video, audio or images.');
  if (body.kind !== 'asset' && (typeof body.projectId !== 'string' || !/^[\w-]{1,100}$/.test(body.projectId))) throw new HttpError(400, 'Results and snapshots need a local project ID.');
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 20 || tags.some(t=>typeof t !== 'string' || !t.trim() || t.length > 40)) throw new HttpError(400, 'Use at most 20 short tags.');
  return { kind: body.kind, name: body.name.trim(), mediaType: body.kind === 'snapshot' ? 'other' : mediaType,
    contentType: body.kind === 'snapshot' ? 'application/zip' : contentType, tags: [...new Set(tags.map(t=>t.trim()))],
    projectId: body.kind === 'asset' ? null : body.projectId, sha256: body.sha256, md5: body.md5 };
}
export function createLibrary(pool: pg.Pool, config: StorageConfig | undefined, limits: Limits) {
  const storage = config ? new Storage(config) : undefined;
  const requireStorage = () => { if (!storage) throw new HttpError(503, 'The operator has not configured OSS storage.'); return storage; };
  async function transaction<T>(user: Owner, fn: (db: pg.PoolClient) => Promise<T>, allowDisabled = false): Promise<T> {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const owner = (await db.query('SELECT disabled FROM cloud_users WHERE id=$1 FOR UPDATE', [user.id])).rows[0];
      if (!owner || (owner.disabled && !allowDisabled)) throw new HttpError(401, 'Account is unavailable.');
      const result = await fn(db); await db.query('COMMIT'); return result;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async function space(user: Owner, db: pg.Pool | pg.PoolClient = pool) {
    const result = await db.query(`SELECT quota_bytes::float8 AS "quotaBytes",
      (SELECT coalesce(sum(size),0)::float8 FROM cloud_blobs WHERE owner_id=$1 AND deleted_at IS NULL) AS "usedBytes",
      (SELECT coalesce(sum(size),0)::float8 FROM cloud_uploads WHERE owner_id=$1 AND state='uploading') AS "reservedBytes"
      FROM cloud_users WHERE id=$1`, [user.id]);
    return { ownerId: user.id, ...result.rows[0] };
  }
  async function item(id: string, user: Owner, db: pg.Pool | pg.PoolClient = pool) {
    if (!uuid(id)) throw new HttpError(404, 'Content not found.');
    const result = await db.query(`SELECT ${itemColumns},b.object_key AS "objectKey" FROM cloud_items i
      JOIN cloud_blobs b ON b.id=i.blob_id JOIN cloud_users u ON u.id=i.owner_id
      WHERE i.id=$1 AND b.deleted_at IS NULL AND NOT u.disabled AND
      (i.owner_id=$2 OR (i.kind='asset' AND i.visibility='public' AND NOT i.withdrawn))`, [id, user.id]);
    if (!result.rows[0]) throw new HttpError(404, 'Content not found or no longer shared.');
    return result.rows[0];
  }
  const publicItem = (row: Record<string, any>) => { const { objectKey, ...safe } = row; return safe; };
  async function task(id: string, user: Owner, db: pg.PoolClient) {
    if (!uuid(id)) throw new HttpError(404, 'Upload not found.');
    const row = (await db.query('SELECT * FROM cloud_uploads WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, user.id])).rows[0];
    if (!row) throw new HttpError(404, 'Upload not found.');
    return row;
  }
  function active(row: any) {
    if (row.state !== 'uploading' || new Date(row.expires_at).getTime() <= Date.now()) throw new HttpError(410, 'Upload is cancelled or expired. Start a new upload.');
  }
  async function discard(db: pg.PoolClient, t: any) {
    await db.query("INSERT INTO cloud_cleanup(object_key,after_at) VALUES($1,now()+interval '16 minutes') ON CONFLICT DO NOTHING", [t.staging_key]);
    await db.query('INSERT INTO cloud_cleanup(object_key,upload_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [t.object_key,t.upload_id]);
  }
  async function cleanup() {
    if (!storage) return;
    const expired = await pool.query("SELECT id,owner_id FROM cloud_uploads WHERE state='uploading' AND expires_at <= now() LIMIT 100");
    for (const row of expired.rows) await transaction({ id: row.owner_id, username: '' }, async db => {
      const t = await task(row.id, { id: row.owner_id, username: '' }, db);
      if (t.state !== 'uploading') return;
      await db.query("UPDATE cloud_uploads SET state='expired' WHERE id=$1", [t.id]);
      await discard(db,t);
    }, true).catch(()=>{});
    for (const row of (await pool.query('SELECT * FROM cloud_cleanup WHERE after_at<=now() LIMIT 100')).rows) {
      try { await storage.remove(row.object_key, row.upload_id); await pool.query('DELETE FROM cloud_cleanup WHERE object_key=$1', [row.object_key]); }
      catch { /* Durable queue: retry after a transient OSS failure. */ }
    }
  }
  async function route(req: IncomingMessage, res: ServerResponse, user: Owner) {
    const url = new URL(req.url!, 'http://localhost'), parts = url.pathname.split('/').filter(Boolean).slice(1);
    const store = requireStorage();
    if (parts[0] === 'items' && parts.length === 1 && req.method === 'GET') {
      const scope = url.searchParams.get('scope') ?? 'mine', kind = url.searchParams.get('kind') ?? '', type = url.searchParams.get('type') ?? '';
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!['mine','public'].includes(scope) || !['','asset','snapshot','result'].includes(kind) || !['','video','audio','image','other'].includes(type) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new HttpError(400, 'Invalid library filter.');
      const rows = await pool.query(`SELECT ${itemColumns} FROM cloud_items i JOIN cloud_blobs b ON b.id=i.blob_id
        JOIN cloud_users u ON u.id=i.owner_id WHERE b.deleted_at IS NULL AND NOT u.disabled
        AND (($2='mine' AND i.owner_id=$1) OR ($2='public' AND i.kind='asset' AND i.visibility='public' AND NOT i.withdrawn))
        AND ($3='' OR i.kind=$3) AND ($4='' OR i.media_type=$4)
        AND ($5='' OR strpos(lower(i.name),lower($5))>0) AND ($6='' OR $6=ANY(i.tags))
        AND ($7='' OR i.project_id=$7) ORDER BY i.created_at DESC,i.id LIMIT 201 OFFSET $8`,
      [user.id,scope,kind,type,(url.searchParams.get('q')??'').slice(0,200),(url.searchParams.get('tag')??'').slice(0,40),url.searchParams.get('projectId')??'',offset]);
      return json(res, 200, { items: rows.rows.slice(0,200), nextOffset: rows.rows.length > 200 ? offset + 200 : null });
    }
    if (parts[0] === 'uploads' && parts.length === 1 && req.method === 'POST') {
      const body = await readJson(req), meta = metadata(body, limits);
      const requestId = body.requestId ?? randomUUID();
      if (!uuid(requestId)) throw new HttpError(400, 'Invalid upload request ID.');
      const created = await transaction(user, async db => {
        const existing = (await db.query('SELECT * FROM cloud_uploads WHERE owner_id=$1 AND request_id=$2', [user.id, requestId])).rows[0];
        if (existing) {
          if (Number(existing.size) !== body.size || Object.keys(meta).some(key=>JSON.stringify(existing.metadata[key]) !== JSON.stringify(meta[key as keyof Metadata]))) throw new HttpError(409, 'This request ID belongs to different content.');
          return existing;
        }
        const usage = await space(user, db);
        if (usage.usedBytes + usage.reservedBytes + body.size > usage.quotaBytes) throw new HttpError(409, 'Not enough space in your cloud account.');
        const id = randomUUID();
        return (await db.query(`INSERT INTO cloud_uploads(id,owner_id,request_id,metadata,size,staging_key,object_key,expires_at,mode,part_bytes)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 second',$9,$10) RETURNING *`,
        [id,user.id,requestId,meta,body.size,store.key(user.id,id,true),store.key(user.id,id),limits.uploadSeconds,body.size > limits.partBytes ? 'multipart' : 'single',Math.max(limits.partBytes,Math.ceil(body.size/10000))])).rows[0];
      });
      return json(res, 201, { id: created.id, mode: created.mode, state: created.state, partBytes: Number(created.part_bytes) });
    }
    if (parts[0] === 'uploads' && parts.length === 3 && req.method === 'POST') {
      const body = await readJson(req);
      const result = await transaction(user, async db => {
        const t = await task(parts[1], user, db);
        if (['complete','status'].includes(parts[2]) && t.state === 'completed') return { state:'completed', item: publicItem(await item(t.item_id, user, db)) };
        if (parts[2] === 'cancel') {
          if (t.state === 'completed') throw new HttpError(409, 'Upload already completed. Delete its content instead.');
          await db.query("UPDATE cloud_uploads SET state='cancelled' WHERE id=$1", [t.id]);
          await discard(db,t);
          return { cancelled: true };
        }
        active(t);
        if (parts[2] === 'status') {
          const final = await store.head(t.object_key);
          const staged = !final && t.mode === 'single' ? await store.head(t.staging_key) : null;
          const head = final ?? staged;
          const uploaded = Boolean(head && head.size === Number(t.size) && head.sha256 === t.metadata.sha256 &&
            (final || head.etag.replaceAll('"','').toLowerCase() === Buffer.from(t.metadata.md5,'base64').toString('hex')));
          return { id:t.id, state:t.state, mode:t.mode, partBytes:Number(t.part_bytes), uploaded,
            parts:!uploaded && t.upload_id ? await store.parts(t.object_key,t.upload_id) : [] };
        }
        if (parts[2] === 'sign') {
          if (t.mode === 'single') return store.signPut(t.staging_key, Number(t.size), t.metadata.md5, t.metadata.sha256, t.metadata.contentType);
          const number = body.partNumber, count = Math.ceil(Number(t.size)/Number(t.part_bytes));
          if (!Number.isInteger(number) || number < 1 || number > count || !/^[A-Za-z0-9+/]{22}==$/.test(body.md5 ?? '')) throw new HttpError(400,'Invalid part number or checksum.');
          const previous = (await db.query('SELECT md5 FROM cloud_upload_parts WHERE upload_id=$1 AND number=$2',[t.id,number])).rows[0];
          if (previous && previous.md5 !== body.md5) throw new HttpError(409,'This part belongs to different source content.');
          if (!t.upload_id) {
            t.upload_id = await store.initiate(t.object_key,t.metadata.sha256,t.metadata.contentType);
            await db.query('UPDATE cloud_uploads SET upload_id=$2 WHERE id=$1',[t.id,t.upload_id]);
          }
          await db.query('INSERT INTO cloud_upload_parts(upload_id,number,md5) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[t.id,number,body.md5]);
          return store.signPart(t.object_key,t.upload_id,number,Math.min(Number(t.part_bytes),Number(t.size)-(number-1)*Number(t.part_bytes)),body.md5);
        }
        if (parts[2] === 'complete') {
          let head = await store.head(t.object_key);
          if (!head) {
            if (t.mode === 'multipart') {
              const actual = t.upload_id ? await store.parts(t.object_key,t.upload_id) : [];
              const expected = (await db.query('SELECT number,md5 FROM cloud_upload_parts WHERE upload_id=$1 ORDER BY number',[t.id])).rows;
              const count = Math.ceil(Number(t.size)/Number(t.part_bytes));
              if (actual.length !== count || expected.length !== count || actual.some((p,i)=>p.number !== i+1 ||
                p.size !== Math.min(Number(t.part_bytes),Number(t.size)-i*Number(t.part_bytes)) ||
                p.etag.replaceAll('"','').toUpperCase() !== Buffer.from(expected[i]?.md5 ?? '', 'base64').toString('hex').toUpperCase()))
                throw new HttpError(409,'OSS has not received all matching parts.');
              await store.complete(t.object_key,t.upload_id,actual);
            } else {
              const staged = await store.head(t.staging_key);
              if (!staged || staged.size !== Number(t.size) || staged.sha256 !== t.metadata.sha256 || staged.etag.replaceAll('"','').toUpperCase() !== Buffer.from(t.metadata.md5,'base64').toString('hex').toUpperCase()) throw new HttpError(409, 'OSS has not received the complete, matching file.');
              await store.publish(t.object_key, t.staging_key, staged.etag);
            }
            head = await store.head(t.object_key);
          }
          if (!head || head.size !== Number(t.size) || head.sha256 !== t.metadata.sha256) throw new HttpError(409, 'The uploaded object did not pass verification.');
          await db.query('INSERT INTO cloud_blobs(id,owner_id,object_key,size,sha256,etag) VALUES($1,$2,$3,$4,$5,$6)', [t.id,user.id,t.object_key,t.size,t.metadata.sha256,head.etag]);
          const m: Metadata = t.metadata;
          await db.query(`INSERT INTO cloud_items(id,owner_id,blob_id,kind,name,media_type,content_type,tags,project_id) VALUES($1,$2,$1,$3,$4,$5,$6,$7,$8)`,
            [t.id,user.id,m.kind,m.name,m.mediaType,m.contentType,m.tags,m.projectId]);
          await db.query("UPDATE cloud_uploads SET state='completed',item_id=$1 WHERE id=$1", [t.id]);
          // A staging grant may be replayed until it expires. Sweep after the last possible grant.
          await db.query("INSERT INTO cloud_cleanup(object_key,after_at) VALUES($1,now()+interval '16 minutes') ON CONFLICT DO NOTHING", [t.staging_key]);
          return { item: publicItem(await item(t.id,user,db)) };
        }
        throw new HttpError(404, 'Upload operation not found.');
      });
      return json(res, 200, result);
    }
    if (parts[0] === 'items' && parts[2] === 'share' && parts.length === 3 && req.method === 'POST') {
      const body = await readJson(req);
      if (body.confirmed !== true) throw new HttpError(400,'Confirm sharing this result as a public asset.');
      return json(res,200,await transaction(user,async db => {
        const row = await item(parts[1],user,db);
        if (row.ownerId !== user.id) throw new HttpError(403,'Only the owner may share this result.');
        if (row.kind !== 'result' || row.mediaType === 'other') throw new HttpError(400,'Only video, audio and image results can become assets.');
        const source = (await db.query('SELECT b.id,b.removed_from_sharing FROM cloud_blobs b JOIN cloud_items i ON i.blob_id=b.id WHERE i.id=$1',[row.id])).rows[0];
        if (source.removed_from_sharing) throw new HttpError(403,'An administrator removed this content from sharing.');
        const blob = source.id;
        const existing = (await db.query("SELECT id,withdrawn FROM cloud_items WHERE blob_id=$1 AND kind='asset'",[blob])).rows[0];
        if (existing?.withdrawn) throw new HttpError(403,'An administrator removed this asset from sharing.');
        const id = existing?.id ?? randomUUID();
        await db.query(`INSERT INTO cloud_items(id,owner_id,blob_id,kind,name,media_type,content_type,tags,visibility)
          VALUES($1,$2,$3,'asset',$4,$5,$6,$7,'public') ON CONFLICT(blob_id,kind) DO UPDATE SET visibility='public'`,
          [id,user.id,blob,row.name,row.mediaType,row.contentType,row.tags]);
        return { item:publicItem(await item(id,user,db)) };
      }));
    }
    if (parts[0] === 'items' && parts[2] === 'delete' && parts.length === 3 && req.method === 'POST') {
      const body = await readJson(req);
      if (body.confirmed !== true) throw new HttpError(400, 'Confirm permanent deletion of cloud content.');
      const result = await transaction(user, async db => {
        const row = await item(parts[1],user,db);
        if (row.ownerId !== user.id) throw new HttpError(403, 'Only the owner may delete this content.');
        const removed = (await db.query('DELETE FROM cloud_items WHERE id=$1 RETURNING blob_id', [row.id])).rows[0];
        if (!(await db.query('SELECT id FROM cloud_items WHERE blob_id=$1', [removed.blob_id])).rowCount) {
          await db.query('UPDATE cloud_blobs SET deleted_at=now() WHERE id=$1', [removed.blob_id]);
          await db.query('INSERT INTO cloud_cleanup(object_key) VALUES($1) ON CONFLICT DO NOTHING', [row.objectKey]);
        }
        return { deleted: true };
      });
      return json(res,200,result);
    }
    if (parts[0] === 'items' && parts[2] === 'download' && parts.length === 3 && req.method === 'POST') {
      await readJson(req);
      const row = await item(parts[1], user);
      return json(res, 200, { ...await store.download(row.objectKey), item: publicItem(row) });
    }
    if (parts[0] === 'items' && ['publish','withdraw'].includes(parts[2]) && parts.length === 3 && req.method === 'POST') {
      const body = await readJson(req);
      if (parts[2] === 'publish' && body.confirmed !== true) throw new HttpError(400, 'Confirm sharing this asset with every signed-in user.');
      const result = await transaction(user, async db => {
        const row = await item(parts[1],user,db);
        if (row.ownerId !== user.id) throw new HttpError(403, 'Only the owner may change sharing.');
        if (row.kind !== 'asset') throw new HttpError(400, 'Only assets can be published.');
        if (row.withdrawn && parts[2] === 'publish') throw new HttpError(403, 'An administrator removed this asset from sharing.');
        await db.query('UPDATE cloud_items SET visibility=$1 WHERE id=$2', [parts[2] === 'publish' ? 'public' : 'private',row.id]);
        return { item: publicItem(await item(row.id,user,db)) };
      });
      return json(res,200,result);
    }
    throw new HttpError(404, 'Cloud operation not found.');
  }
  return { route, space, cleanup };
}
