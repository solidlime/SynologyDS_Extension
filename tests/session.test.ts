// Regression guard for the session-race fixes in src/api/synology.ts.
// The module is bundled with esbuild so it can run outside Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outfile = join(mkdtempSync(join(tmpdir(), 'syno-')), 'synology.mjs');
buildSync({
  entryPoints: ['src/api/synology.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile,
  logLevel: 'error',
});

(globalThis as Record<string, unknown>)['chrome'] = {
  runtime: { getManifest: () => ({ version: '1.0.0' }) },
};

const { SynologyAPI } = (await import(pathToFileURL(outfile).href)) as typeof import('../src/api/synology.ts');

const SETTINGS = { url: 'http://nas:5000', username: 'u', password: 'p' };

const API_INFO = {
  success: true,
  data: {
    'SYNO.API.Auth': { path: 'entry.cgi', maxVersion: 7, minVersion: 1 },
    'SYNO.DownloadStation.Task': { path: 'DownloadStation/task.cgi', maxVersion: 3, minVersion: 1 },
    'SYNO.FileStation.Download': { path: 'entry.cgi', maxVersion: 2, minVersion: 1 },
  },
};

type Handler = (call: { url: string; body: URLSearchParams }) => Promise<unknown> | unknown;

/** Replaces fetch with a scripted NAS. */
function stubFetch(handler: Handler, counter: { logins: number }): void {
  (globalThis as Record<string, unknown>)['fetch'] = async (url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    if (body.has('_sid')) assert.ok(body.get('_sid'), 'a request carried an empty _sid');
    if (String(url).includes('query.cgi')) return reply(API_INFO);
    if (body.get('method') === 'login') {
      counter.logins += 1;
      return reply({ success: true, data: { sid: `S${counter.logins}` } });
    }
    return reply(await handler({ url: String(url), body }));
  };
}

const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

test('a late 105 for an already-replaced sid does not force another login', async () => {
  const counter = { logins: 0 };
  let taskCalls = 0;
  let releaseOld: () => void = () => {};
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });

  stubFetch(async ({ body }) => {
    const n = ++taskCalls;
    if (n === 1) await oldGate; // first request's 105 arrives after the refresh
    if (body.get('_sid') === 'S1') return { success: false, error: { code: 105 } };
    return { success: true, data: { tasks: [], total: 0 } };
  }, counter);

  const api = new SynologyAPI('DSManagerTest');
  await api.login(SETTINGS);
  assert.equal(counter.logins, 1);

  const first = api.listTasks();
  const second = api.listTasks(); // gets its 105 first, refreshes to S2

  await second;
  releaseOld();
  await first;

  assert.equal(counter.logins, 2, 'only the initial login plus one refresh');
  assert.equal(taskCalls, 4);
});

test('concurrent expiries share a single re-login', async () => {
  const counter = { logins: 0 };
  let taskCalls = 0;

  stubFetch(async ({ body }) => {
    taskCalls += 1;
    if (body.get('_sid') === 'S1') return { success: false, error: { code: 105 } };
    return { success: true, data: { tasks: [], total: 0 } };
  }, counter);

  const api = new SynologyAPI('DSManagerTest');
  await api.login(SETTINGS);

  await Promise.all([api.listTasks(), api.listTasks()]);

  assert.equal(counter.logins, 2, 'two concurrent 105s must not log in twice');
  assert.equal(taskCalls, 4);
});
