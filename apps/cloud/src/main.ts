import { startCloud } from './server.ts';

const databaseUrl = process.env.DATABASE_URL;
const port = Number(process.env.PORT ?? 8080);
if (!databaseUrl || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Set DATABASE_URL and a valid PORT (default 8080).');
  process.exit(1);
}

try {
  const cloud = await startCloud({ databaseUrl, port, host: process.env.HOST ?? '0.0.0.0' });
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
  console.error('OpenFilm Cloud could not start. Check database connectivity and migration permissions.');
  process.exit(1);
}
