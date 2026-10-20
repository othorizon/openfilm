import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';

/** Apply each migration once, atomically, including during concurrent service startup. */
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7624901)');
    await client.query('CREATE TABLE IF NOT EXISTS cloud_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT name FROM cloud_migrations WHERE name = $1', [name])).rowCount) continue;
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('INSERT INTO cloud_migrations(name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
