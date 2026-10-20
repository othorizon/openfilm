/** An HTTP boundary double for OSS. Cloud and local client still use their real network implementations. */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex').toUpperCase();
export async function ossServer() {
  const objects = new Map<string, { bytes: Buffer; headers: Record<string, string>; etag: string }>();
  const uploads = new Map<string, { key: string; headers: Record<string, string>; parts: Map<number, Buffer> }>();
  const evidence = { puts: 0, gets: 0, bytes: 0, copies: 0, failPut: 0, interruptPut: false, interruptComplete: false, interruptGetAt: 0, interruptGet: false, rejectGet: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const key = decodeURIComponent(url.pathname.slice(1));
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => key.startsWith('x-oss-meta-') || key === 'content-type').map(([k, v]) => [k, String(v)]));
    const error = (status: number, code: string) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`); };
    const xml = (text: string) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(text); };
    const id = url.searchParams.get('uploadId');
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const uploadId = randomUUID(); uploads.set(uploadId, { key, headers, parts: new Map() });
      return xml(`<InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (id) {
      const up = uploads.get(id);
      if (!up || up.key !== key) return error(404, 'NoSuchUpload');
      if (req.method === 'DELETE') { uploads.delete(id); res.writeHead(204); return res.end(); }
      if (req.method === 'GET') return xml(`<ListPartsResult><UploadId>${id}</UploadId><IsTruncated>false</IsTruncated>${[...up.parts].sort((a,b)=>a[0]-b[0]).map(([n, b])=>`<Part><PartNumber>${n}</PartNumber><Size>${b.length}</Size><ETag>"${md5(b)}"</ETag></Part>`).join('')}</ListPartsResult>`);
      if (req.method === 'POST') {
        const parts = [...body.toString().matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>"?([^<"]+)"?<\/ETag>\s*<\/Part>/g)];
        if (!parts.length || parts.some(p => !up.parts.has(Number(p[1])) || md5(up.parts.get(Number(p[1]))!) !== p[2])) return error(400, 'InvalidPart');
        const bytes = Buffer.concat(parts.map(p=>up.parts.get(Number(p[1]))!));
        objects.set(key, { bytes, headers: up.headers, etag: `${md5(bytes)}-${parts.length}` }); uploads.delete(id);
        if(evidence.interruptComplete){evidence.interruptComplete=false;res.destroy();return;}
        return xml(`<CompleteMultipartUploadResult><ETag>"${md5(bytes)}-${parts.length}"</ETag></CompleteMultipartUploadResult>`);
      }
    }
    if (req.method === 'PUT') {
      if (req.headers['x-oss-copy-source']) {
        const source = objects.get(decodeURIComponent(String(req.headers['x-oss-copy-source'])).replace(/^\/test-bucket\//, ''));
        if (!source) return error(404, 'NoSuchKey');
        if (req.headers['x-oss-copy-source-if-match'] !== `"${source.etag}"`) return error(412, 'PreconditionFailed');
        objects.set(key, { ...source, bytes: Buffer.from(source.bytes) }); evidence.copies += 1;
        return xml(`<CopyObjectResult><ETag>"${source.etag}"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>`);
      }
      evidence.puts += 1; evidence.bytes += body.length;
      if (evidence.failPut > 0 && --evidence.failPut === 0) return error(503, 'ServiceUnavailable');
      if (req.headers['content-md5'] !== createHash('md5').update(body).digest('base64')) return error(400, 'BadDigest');
      if (id) uploads.get(id)!.parts.set(Number(url.searchParams.get('partNumber')), body);
      else {
        if (objects.has(key) && req.headers['x-oss-forbid-overwrite'] === 'true') return error(409, 'FileAlreadyExists');
        objects.set(key, { bytes: body, headers, etag: md5(body) });
      }
      if(evidence.interruptPut){evidence.interruptPut=false;res.destroy();return;}
      res.writeHead(200, { etag: `"${md5(body)}"` }); return res.end();
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    const object = objects.get(key);
    if (!object) return error(404, 'NoSuchKey');
    if (req.method === 'HEAD') { res.writeHead(200, { ...object.headers, 'content-length': object.bytes.length, etag: `"${object.etag}"` }); return res.end(); }
    if (req.method === 'GET') {
      evidence.gets += 1;
      if (evidence.rejectGet) { evidence.rejectGet = false; return error(403, 'AccessDenied'); }
      if (req.headers['if-match'] && req.headers['if-match'] !== `"${object.etag}"`) return error(412, 'PreconditionFailed');
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : object.bytes.length - 1;
      const bytes = object.bytes.subarray(start, end + 1);
      res.writeHead(range ? 206 : 200, { ...object.headers, etag: `"${object.etag}"`, 'content-length': bytes.length,
        ...(range ? { 'content-range': `bytes ${start}-${end}/${object.bytes.length}` } : {}) });
      if (evidence.interruptGet || (evidence.interruptGetAt > 0 && evidence.gets === evidence.interruptGetAt)) {
        evidence.interruptGet = false; res.write(bytes.subarray(0, Math.min(1024, bytes.length)));
        setTimeout(()=>res.destroy(), 50); return;
      }
      return res.end(bytes);
    }
    error(405, 'MethodNotAllowed');
  });
  await new Promise<void>(resolve=>server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    config: { bucket: 'test-bucket', region: 'cn-beijing', endpoint: `http://127.0.0.1:${address.port}`, prefix: 'approved/test/', accessKeyId: 'test-only-id', accessKeySecret: 'test-only-secret', cname: true },
    evidence, objects, uploads,
    close: () => new Promise<void>(resolve=>server.close(()=>resolve())),
  };
}
