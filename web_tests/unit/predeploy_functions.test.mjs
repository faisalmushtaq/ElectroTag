// The functions' predeploy step (scripts/predeploy_functions.mjs) finds Python on every system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { pythonCandidates, vendor } from '../../scripts/predeploy_functions.mjs';

test('the functions\' own environment comes first, then the usual names of each system', () => {
  assert.deepEqual(pythonCandidates('/repo/fn', 'linux'), ['/repo/fn/venv/bin/python', 'python3', 'python']);
  assert.deepEqual(pythonCandidates('/repo/fn', 'darwin'), ['/repo/fn/venv/bin/python', 'python3', 'python']);
  assert.deepEqual(pythonCandidates('C:\\repo\\fn', 'win32'), ['C:\\repo\\fn\\venv\\Scripts\\python.exe', 'py', 'python', 'python3']);
});

/** A stand-in for spawnSync: `installed` maps a Python's name to the exit code it gives. */
function fakeRun(installed) {
  const ran = [];
  const run = (cmd, args) => {
    ran.push(cmd);
    if (!(cmd in installed)) return { error: Object.assign(new Error('not found'), { code: 'ENOENT' }), status: null };
    return { status: installed[cmd] };
  };
  return { run, ran };
}

test('on Windows without the environment, the py launcher runs the vendoring script', () => {
  const { run, ran } = fakeRun({ py: 0 });
  const code = vendor('C:\\repo\\fn', { platform: 'win32', run, exists: () => false, log: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(ran, ['py']);
});

test('the Microsoft Store stand-in for python is passed over', () => {
  const { run, ran } = fakeRun({ python: 9009, python3: 0 });
  assert.equal(vendor('C:\\repo\\fn', { platform: 'win32', run, exists: () => false, log: () => {} }), 0);
  assert.deepEqual(ran, ['py', 'python', 'python3']);
});

test('the functions\' environment is used when it exists, with the script and the folder', () => {
  const seen = [];
  const run = (cmd, args) => { seen.push([cmd, ...args]); return { status: 0 }; };
  const venv = '/repo/fn/venv/bin/python';
  assert.equal(vendor('/repo/fn', { platform: 'linux', run, exists: (p) => p === venv, log: () => {} }), 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], venv);
  assert.equal(path.basename(seen[0][1]), 'vendor_functions.py');
  assert.equal(seen[0][2], '/repo/fn');
});

test('the script\'s own failure is passed on, and no Python at all says what to do', () => {
  const failing = fakeRun({ python3: 2 });
  assert.equal(vendor('/repo/fn', { platform: 'linux', run: failing.run, exists: () => false, log: () => {} }), 2);
  const said = [];
  const none = fakeRun({});
  assert.equal(vendor('/repo/fn', { platform: 'linux', run: none.run, exists: () => false, log: (m) => said.push(m) }), 1);
  assert.match(said[0], /step 8 of docs\/web\/firebase\.md/);
});
