/** Server-operator CLI: DATABASE_URL is privileged and must never be distributed to clients. */
import pg from 'pg';
import { migrate } from './database.ts';
import { passwordHash } from './password.ts';
import { HttpError } from './http.ts';

const [command, subject, ...flags] = process.argv.slice(2);
const actor = flags[flags.indexOf('--as') + 1];
if (!process.env.DATABASE_URL || !subject || !['init', 'reset', 'disable', 'enable', 'remove', 'quota'].includes(command)) {
  console.error('Set DATABASE_URL. Usage: admin init <existing-user> | reset <user> --as <admin> --password-stdin | disable|enable <user> --as <admin> | remove <asset-id> --as <admin> | quota <user> <bytes> --as <admin>');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (command !== 'init') {
      if (!flags.includes('--as') || !(await client.query('SELECT id FROM cloud_users WHERE username = $1 AND admin AND NOT disabled', [actor])).rowCount) {
        throw new HttpError(403, 'Name an enabled administrator with --as.');
      }
    }
    if (command === 'remove') {
      const asset = (await client.query("SELECT owner_id,blob_id FROM cloud_items WHERE id=$1 AND kind='asset'",[subject])).rows[0];
      if (!asset) throw new HttpError(404,'Asset not found.');
      await client.query('SELECT id FROM cloud_users WHERE id=$1 FOR UPDATE',[asset.owner_id]);
      await client.query('UPDATE cloud_blobs SET removed_from_sharing=true WHERE id=$1',[asset.blob_id]);
      await client.query("UPDATE cloud_items SET withdrawn=true,visibility='private' WHERE blob_id=$1 AND kind='asset'",[asset.blob_id]);
    } else {
    const user = (await client.query('SELECT id FROM cloud_users WHERE username = $1 FOR UPDATE', [subject.normalize('NFKC').trim().toLowerCase()])).rows[0];
    if (!user) throw new HttpError(404, 'Account not found.');
    if (command === 'init') await client.query('UPDATE cloud_users SET admin = true WHERE id = $1', [user.id]);
    if (command === 'reset') {
      if (!flags.includes('--password-stdin') || process.stdin.isTTY) throw new HttpError(400, 'Provide the new password through --password-stdin.');
      let input = '';
      for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 4096) throw new HttpError(400, 'Password input is too large.'); }
      const hash = await passwordHash(input.replace(/\r?\n$/, ''));
      await client.query('UPDATE cloud_users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    }
    if (command === 'disable' || command === 'enable') await client.query('UPDATE cloud_users SET disabled = $1 WHERE id = $2', [command === 'disable', user.id]);
    if (command === 'reset' || command === 'disable') await client.query('DELETE FROM cloud_sessions WHERE user_id = $1', [user.id]);
    if (command === 'quota') {
      const bytes = Number(flags[0]);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new HttpError(400,'Quota must be a nonnegative whole number of bytes.');
      await client.query('UPDATE cloud_users SET quota_bytes=$1 WHERE id=$2',[bytes,user.id]);
    }
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ operation: command, account: subject, ok: true }));
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} catch (error) {
  console.error(error instanceof HttpError ? error.message : 'Administrator command failed. Check database access.');
  process.exitCode = 1;
} finally { await pool.end(); }
