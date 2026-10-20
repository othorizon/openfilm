import { defaultLimits, type Limits } from './library.ts';
import { startCloud } from './server.ts';

const databaseUrl = process.env.DATABASE_URL;
const port = Number(process.env.PORT ?? 8080);
if (!databaseUrl || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set DATABASE_URL and a valid PORT (default 8080).');
  process.exit(1);
}

try {
  const names: Record<keyof Limits,string> = {quotaBytes:'CLOUD_QUOTA_BYTES',fileBytes:'CLOUD_FILE_BYTES',snapshotBytes:'CLOUD_SNAPSHOT_BYTES',partBytes:'CLOUD_PART_BYTES',uploadSeconds:'CLOUD_UPLOAD_SECONDS',cleanupSeconds:'CLOUD_CLEANUP_SECONDS'};
  const limits = Object.fromEntries(Object.entries(names).map(([key,name])=>[key,process.env[name]===undefined?defaultLimits[key as keyof Limits]:Number(process.env[name])])) as Limits;
  const cloud = await startCloud({ databaseUrl, port, host: process.env.HOST ?? '0.0.0.0', limits });
  console.log(`OpenFilm Cloud listening on port ${port}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000).unref();
    void cloud.close().then(() => { clearTimeout(deadline); }, () => process.exit(1));
  });
} catch {
  // Connection strings and database errors can contain credentials.
  console.error('OpenFilm Cloud could not start. Check database connectivity, migration permissions, OSS configuration and limits.');
  process.exit(1);
}
