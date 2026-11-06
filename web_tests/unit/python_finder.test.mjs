// The Python the browser tests use beside Node.js (web_tests/python.mjs): the virtual environment's
// Python on every system, Windows's included, and a Python on the PATH by the names each system uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultPython, findPython, pythonCandidates } from '../python.mjs';

test('the candidates name the virtual environment as each system lays it out, then the usual names', () => {
  assert.deepEqual(pythonCandidates({ env: {}, platform: 'linux', repo: '/repo' }),
    ['/repo/.venv/bin/python', '/repo/.venv/Scripts/python.exe', 'python3', 'python']);
  assert.deepEqual(pythonCandidates({ env: {}, platform: 'darwin', repo: '/repo' }),
    ['/repo/.venv/bin/python', '/repo/.venv/Scripts/python.exe', 'python3', 'python']);
  assert.deepEqual(pythonCandidates({ env: {}, platform: 'win32', repo: 'C:\\repo' }),
    ['C:\\repo\\.venv\\bin\\python', 'C:\\repo\\.venv\\Scripts\\python.exe', 'python', 'py', 'python3']);
  assert.equal(pythonCandidates({ env: { ELECTROTAG_PYTHON: 'C:\\Py\\python.exe' }, platform: 'win32' })[0], 'C:\\Py\\python.exe');
});

test('a Windows virtual environment is found without ELECTROTAG_PYTHON', () => {
  const venv = /\.venv\\Scripts\\python\.exe$/;
  const exists = (p) => venv.test(p);
  const tried = [];
  const run = (p) => { tried.push(p); return { status: venv.test(p) ? 0 : 1 }; };
  const found = findPython('import mne', { env: {}, platform: 'win32', exists, run });
  assert.match(found, venv);
  assert.deepEqual(tried, [found], 'the missing .venv\\bin\\python is passed over without being started');
  assert.match(defaultPython({ env: {}, platform: 'win32', exists }), venv);
});

test('without a virtual environment the names on the PATH are tried in turn, and none gives null', () => {
  const tried = [];
  const run = (p, args) => { tried.push([p, ...args]); return { status: p === 'py' ? 0 : 9009 }; };
  assert.equal(findPython('import zipfile', { args: ['-I'], env: {}, platform: 'win32', exists: () => false, run }), 'py');
  assert.deepEqual(tried, [['python', '-I', '-c', 'import zipfile'], ['py', '-I', '-c', 'import zipfile']]);
  assert.equal(findPython('import x', { env: {}, platform: 'linux', exists: () => false, run: () => ({ status: 1 }) }), null);
  assert.equal(defaultPython({ env: {}, platform: 'win32', exists: () => false }), 'python');
  assert.equal(defaultPython({ env: {}, platform: 'linux', exists: () => false }), 'python3');
  assert.equal(defaultPython({ env: { ELECTROTAG_PYTHON: 'py' }, platform: 'win32' }), 'py');
});
