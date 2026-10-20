import OSS from 'ali-oss';
import { globalAgent as agent } from 'node:http';
import { globalAgent as httpsAgent } from 'node:https';
import { HttpError } from './http.ts';

export type StorageConfig = {
  bucket: string; region: string; endpoint: string; prefix: string;
  accessKeyId: string; accessKeySecret: string; cname?: boolean;
};
export function storageFromEnv(): StorageConfig | undefined {
  if (!process.env.OSS_BUCKET) return undefined;
  const config = {
    bucket: process.env.OSS_BUCKET, region: process.env.OSS_REGION ?? '',
    endpoint: process.env.OSS_ENDPOINT ?? '', prefix: process.env.OSS_PREFIX ?? '',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID ?? '', accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET ?? '',
    cname: process.env.OSS_CNAME === 'true',
  };
  if (Object.entries(config).some(([k, v])=>k !== 'cname' && !v)) throw new Error('Incomplete OSS configuration.');
  return config;
}
/** Only control operations and signatures. File bodies never enter this adapter. */
export class Storage {
  client: OSS;
  prefix: string;
  constructor(config: StorageConfig) {
    const endpoint = new URL(config.endpoint);
    if (!config.prefix || config.prefix.startsWith('/') || config.prefix.split('/').some(x=>x === '..' || x === '.') || config.prefix.includes('\\')) throw new Error('OSS_PREFIX must be a nonempty, safe bucket prefix.');
    if (endpoint.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)) throw new Error('OSS requires HTTPS.');
    this.prefix = config.prefix.replace(/\/+$/, '') + '/openfilm/';
    this.client = new OSS({ ...config, region: config.region.startsWith('oss-') ? config.region : `oss-${config.region}`,
      authorizationV4: true, timeout: 20_000, ...{ agent, httpsAgent } });
  }
  key(owner: string, id: string, staging = false) { return `${this.prefix}${staging ? 'staging' : 'objects'}/${owner}/${id}`; }
  async head(key: string) {
    try {
      const result = await this.client.head(key);
      const h = result.res.headers as Record<string, string>;
      return { size: Number(h['content-length']), etag: String(h.etag), sha256: String(h['x-oss-meta-sha256'] ?? '') };
    } catch (error) { if ((error as { status?: number }).status === 404) return null; throw error; }
  }
  async signPut(key: string, size: number, md5: string, sha256: string, contentType: string) {
    const headers = { 'content-type': contentType, 'content-length': String(size), 'content-md5': md5,
      'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true', 'x-oss-meta-sha256': sha256 };
    const url = await this.client.signatureUrlV4('PUT', 900, { headers }, key, ['content-length']);
    return { url, headers, expiresIn: 900 };
  }
  async publish(key: string, staging: string, etag: string) {
    await this.client.copy(key, staging, { headers: { 'x-oss-copy-source-if-match': etag, 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private' } });
  }
  async initiate(key: string, sha256: string, contentType: string) {
    return (await this.client.initMultipartUpload(key, { mime: contentType,
      headers: { 'x-oss-meta-sha256': sha256, 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' } })).uploadId;
  }
  async signPart(key: string, uploadId: string, number: number, size: number, md5: string) {
    const headers = { 'content-length': String(size), 'content-md5': md5 };
    const url = await this.client.signatureUrlV4('PUT',900,{headers,queries:{uploadId,partNumber:String(number)}},key,['content-length']);
    return { url, headers, expiresIn: 900 };
  }
  async parts(key: string, uploadId: string) {
    const parts: { number: number; size: number; etag: string }[] = [];
    let marker = 0;
    for (;;) {
      const result = await this.client.listParts(key,uploadId,{'part-number-marker':marker,'max-parts':1000,'encoding-type':'url'});
      const entries = result.parts ? (Array.isArray(result.parts) ? result.parts : [result.parts]) : [];
      for (const part of entries) parts.push({number:Number(part.PartNumber),size:Number((part as unknown as {Size:number}).Size),etag:String(part.ETag)});
      if (String(result.isTruncated) !== 'true') return parts;
      const next = Number(result.nextPartNumberMarker);
      if (next <= marker) throw new Error('Invalid OSS part pagination.');
      marker = next;
    }
  }
  async complete(key: string, uploadId: string, parts: {number:number;etag:string}[]) {
    await this.client.completeMultipartUpload(key,uploadId,parts,{headers:{'x-oss-forbid-overwrite':'true','x-oss-object-acl':'private'}});
  }
  async download(key: string) {
    const url = await this.client.signatureUrlV4('GET', 10800, {}, key);
    return { url, expiresIn: 10800, expiresAt: new Date(Date.now() + 10_800_000).toISOString() };
  }
  async remove(key: string, uploadId?: string | null) {
    if (!key.startsWith(this.prefix)) throw new HttpError(400, 'Object is outside the configured storage prefix.');
    if (uploadId) {
      try { await this.client.abortMultipartUpload(key, uploadId); }
      catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    }
    try { await this.client.delete(key); }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
  }
}
