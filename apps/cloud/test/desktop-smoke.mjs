/** Optional actual Electron acceptance, after `pnpm build`; requires a disposable PostgreSQL database. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabase } from './database.ts';
import { ossServer } from './oss-server.ts';
import { startCloud } from '../src/server.ts';
import { prepare, DESKTOP, waitForCdp } from '../../desktop/bench/app.mjs';

const require = createRequire(new URL('../../desktop/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const db = await testDatabase();
const oss = await ossServer();
const cloud = await startCloud({ databaseUrl: db.url, port: 0, storage: oss.config });
const scratch = await mkdtemp(join(tmpdir(), 'openfilm-cloud-desktop-'));
prepare(scratch);
const env = { ...process.env, OPENFILM_DESKTOP_FLAVOR: 'bench', OPENFILM_BENCH_DIR: scratch, OPENFILM_NO_UPDATE_CHECK: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [DESKTOP, '--no-sandbox', ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []), '--disable-gpu', '--remote-debugging-port=19327'], {
  env, stdio: ['ignore', 'ignore', 'pipe'],
});
let logs = '';
child.stderr.on('data', chunk => { logs += chunk; });
let browser, pageForFailure;
try {
  await waitForCdp('http://127.0.0.1:19327');
  const devtools = await (await fetch('http://127.0.0.1:19327/json/version')).json();
  browser = await chromium.connectOverCDP(devtools.webSocketDebuggerUrl);
  const context = browser.contexts()[0];
  let page;
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    page = context.pages().find(p => p.url().startsWith('http://127.0.0.1:4767') && !p.url().includes('/desktop/'));
    if (page && await page.getByRole('button', { name: 'Settings', exact: true }).count()) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Electron opened the real Studio view');
  page.setDefaultTimeout(10_000);
  // First open a local project, without an account, then use its visible Settings entry.
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const opened = Date.now() + 20_000;
  while (Date.now() < opened) {
    const projectPage = context.pages().find(p => p.url().startsWith('http://127.0.0.1:4767/projects/'));
    if (projectPage) { page = projectPage; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(page.url(), /\/projects\//);
  page.setDefaultTimeout(15_000);
  pageForFailure = page;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cloud account', exact: true }).click();
  await page.getByLabel('Service URL', { exact: true }).fill(cloud.origin);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('desktop-user');
  await page.getByLabel('Password', { exact: true }).fill('desktop-test-password');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await page.getByText('desktop-user', { exact: true }).waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /0 GB \/ 10 GB/);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  // A successful registration returns to the registration form after sign-out.
  await page.getByRole('button', { name: 'Use an existing account', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Username or password is incorrect' }).waitFor();
  await page.getByLabel('Password', { exact: true }).fill('desktop-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('desktop-user', { exact: true }).waitFor();
  const image=join(scratch,'desktop.png');
  await writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=','base64'));
  const projectId=new URL(page.url()).pathname.split('/')[2];
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('tab', { name: 'My cloud', exact: true }).click();
  const pool = page.getByRole('tabpanel', { name: 'My cloud', exact: true });
  await pool.getByText('desktop-user', { exact: true }).waitFor();
  // A real File drop exercises the browser fallback as well as the confirmation dialog.
  const payload = await page.evaluateHandle(base64 => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'desktop.png', { type: 'image/png' }));
    return transfer;
  }, (await readFile(image)).toString('base64'));
  await pool.locator('section').dispatchEvent('drop', { dataTransfer: payload });
  const dialog = page.getByRole('dialog', { name: 'Upload to my cloud', exact: true });
  await dialog.getByLabel('Media name', { exact: true }).fill('Cloud sunset');
  await dialog.getByLabel('Tags', { exact: true }).fill('travel, 北京');
  assert.equal(await pool.locator('[data-cloud-item]').count(), 0, 'dropping files asks for confirmation before upload');
  assert.equal(oss.evidence.puts, 0, 'no bytes reach OSS before confirmation');
  await dialog.getByRole('button', { name: 'Upload file', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await pool.getByText('Completed', { exact: true }).waitFor();
  await pool.getByRole('button', { name: 'Transfers', exact: true }).click();
  const tile = pool.locator('[data-cloud-item]').filter({ hasText: 'Cloud sunset.png' });
  await tile.waitFor();
  assert.match(await tile.innerText(), /travel.*北京/);
  assert.match(await tile.innerText(), /Private/);
  await tile.click();
  await page.waitForFunction(() => [...document.querySelectorAll('img[alt="Cloud sunset.png"]')].filter(img => img.complete && img.naturalWidth === 1).length >= 2);
  await tile.getByRole('button', { name: 'Media actions: Cloud sunset.png', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Make public', exact: true }).click();
  await page.getByRole('dialog', { name: 'Share this media with all signed-in users?', exact: true }).getByRole('button').last().click();
  await page.getByRole('tab', { name: 'Shared cloud', exact: true }).click();
  const shared = page.getByRole('tabpanel', { name: 'Shared cloud', exact: true }).locator('[data-cloud-item]').filter({ hasText: 'Cloud sunset.png' });
  await shared.waitFor();
  // Use the actual resource drag payload and the timeline's drop handlers.
  const drag = await page.evaluateHandle(() => new DataTransfer());
  await shared.dispatchEvent('dragstart', { dataTransfer: drag });
  const target = page.locator('[data-timeline-empty]');
  const rect = await target.boundingBox();
  assert.ok(rect);
  const point = { clientX: rect.x + 70, clientY: rect.y + 35, dataTransfer: drag };
  await target.dispatchEvent('dragover', point);
  await page.locator('[data-timeline] .tl-scroll').dispatchEvent('drop', point);
  await shared.dispatchEvent('dragend', { dataTransfer: drag });
  await page.locator('[data-block-id]').first().waitFor();
  const projects = await page.evaluate(async () => (await fetch('/api/projects')).json());
  const project = projects.projects.find(project => project.id === projectId);
  const film = await readFile(join(project.path, 'film.html'), 'utf8');
  assert.match(film, /assets\/Cloud sunset\.png/);
  assert.ok(!film.includes('Signature=') && !film.includes('cloud/'), 'timeline persists only a local media path');
  await page.getByRole('tab', { name: 'Local media', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Local media', exact: true }).getByText('Cloud sunset.png', { exact: true }).first().waitFor();
  await page.getByRole('tab', { name: 'My cloud', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'My cloud', exact: true }).locator('[data-cloud-item]').waitFor();
  if (process.env.OPENFILM_TEST_ARTIFACTS) {
    await mkdir(process.env.OPENFILM_TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(process.env.OPENFILM_TEST_ARTIFACTS, 'cloud-library.png') });
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cloud account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'My cloud', exact: true }).getByRole('button', { name: 'Cloud account', exact: true }).waitFor();
  assert.equal(await page.getByText('desktop-user', { exact: true }).count(), 0);
  assert.equal(await page.locator('[data-cloud-item]').count(), 0);
  console.log('Desktop acceptance passed: accounts, media selection, confirmed direct upload, preview, sharing, local import and transfer progress.');
} catch (error) {
  if (pageForFailure && process.env.OPENFILM_TEST_ARTIFACTS) { await mkdir(process.env.OPENFILM_TEST_ARTIFACTS, { recursive: true }); await pageForFailure.screenshot({ path: join(process.env.OPENFILM_TEST_ARTIFACTS, 'failure.png') }).catch(() => {}); }
  console.error(logs.slice(-4000));
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(kill);
  }
  await cloud.close();
  await oss.close();
  await db.close();
  await rm(scratch, { recursive: true, force: true });
}
