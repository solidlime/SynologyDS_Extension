// Guards the actual cause of "API error (code 102)": DownloadStation must never
// be sent to entry.cgi. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathFor, TASK_API } from '../src/api/paths.ts';

const discovered = {
  [TASK_API]: { path: 'DownloadStation/task.cgi', maxVersion: 3, minVersion: 1 },
  'SYNO.API.Auth': { path: 'entry.cgi', maxVersion: 7, minVersion: 1 },
};

test('uses the discovered path', () => {
  assert.equal(pathFor(discovered, TASK_API), 'DownloadStation/task.cgi');
});

test('falls back to the known path when discovery failed', () => {
  assert.equal(pathFor({}, TASK_API), 'DownloadStation/task.cgi');
});

// The 102 regression: DownloadStation must never be sent to entry.cgi.
test('never routes the task API to entry.cgi', () => {
  assert.notEqual(pathFor({}, TASK_API), 'entry.cgi');
});

test('falls back to entry.cgi for anything else', () => {
  assert.equal(pathFor({}, 'SYNO.API.Auth'), 'entry.cgi');
  assert.equal(pathFor({}, 'SYNO.FileStation.Download'), 'entry.cgi');
});
