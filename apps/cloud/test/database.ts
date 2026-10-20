import pg from 'pg';
import { randomUUID } from 'node:crypto';

/** Each test process gets an isolated schema in an explicitly supplied test database. */
export async function testDatabase() {
  const connectionString = process.env.OPENFILM_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('Set OPENFILM_TEST_DATABASE_URL to a disposable PostgreSQL database.');
  const admin = new pg.Pool({ connectionString });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return {
    url: url.href,
    async close() {
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await admin.end(); }
    },
  };
}
