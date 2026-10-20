/** Optional actual Electron acceptance, after `pnpm build`; requires a disposable PostgreSQL database. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
let browser;
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
  page.setDefaultTimeout(10_000);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Cloud account', exact: true }).click();
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
  await page.getByLabel('Local project',{exact:true}).selectOption(projectId);
  await page.getByLabel('File path (absolute or project-relative)',{exact:true}).fill(image);
  await page.getByRole('button',{name:'Upload file',exact:true}).click();
  await page.getByRole('dialog',{name:'Upload to your cloud space?',exact:true}).getByRole('button').last().click();
  await page.getByText('Completed',{exact:true}).waitFor();
  await page.getByRole('button',{name:'My assets',exact:true}).click();
  await page.getByRole('heading',{name:'desktop.png',exact:true}).waitFor();
  await page.getByRole('button',{name:'Preview',exact:true}).click();
  await page.getByAltText('desktop.png',{exact:true}).waitFor();
  assert.ok(await page.getByAltText('desktop.png',{exact:true}).evaluate(image=>image.complete&&image.naturalWidth===1));
  await page.getByRole('button',{name:'Make public',exact:true}).click();
  await page.getByRole('dialog',{name:'Share this media with all signed-in users?',exact:true}).getByRole('button').last().click();
  await page.getByRole('button',{name:'Make private',exact:true}).waitFor();
  await page.getByRole('button',{name:'Download into project',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('span')].filter(el=>el.textContent==='Completed').length>=2);
  await page.getByText('assets/desktop.png',{exact:true}).waitFor();
  if (process.env.OPENFILM_TEST_ARTIFACTS) {
    await mkdir(process.env.OPENFILM_TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(process.env.OPENFILM_TEST_ARTIFACTS, 'cloud-library.png') });
  }
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).waitFor();
  assert.equal(await page.getByText('desktop-user', { exact: true }).count(), 0);
  console.log('Desktop acceptance passed: accounts, media selection, confirmed direct upload, preview, sharing, local import and transfer progress.');
} catch (error) {
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
