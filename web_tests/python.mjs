// The Python the browser tests use beside Node.js (docs/testing_guide.md, "Running the tests"):
// $ELECTROTAG_PYTHON when it is set, then the repository's virtual environment (.venv/bin/python on
// macOS and Linux, .venv\Scripts\python.exe on Windows), then a Python on the PATH, whose name
// differs between systems (python3 on macOS and Linux; python, or the launcher py, on Windows).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The Pythons to try, in order. */
export function pythonCandidates({ env = process.env, platform = process.platform, repo = REPO } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const onPath = platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  return [env.ELECTROTAG_PYTHON, p.join(repo, '.venv', 'bin', 'python'), p.join(repo, '.venv', 'Scripts', 'python.exe'), ...onPath]
    .filter(Boolean);
}

/** A candidate named by its path that is not there is passed over; a bare name is tried. */
const isPath = (p) => p.includes('/') || p.includes('\\');

/**
 * The first Python that runs `code` without an error (for example `import mne`), or null. `args` go
 * before `-c` (such as `-I`); `cwd` and `env` are those of the check.
 */
export function findPython(code, { args = [], cwd = REPO, env = process.env, platform = process.platform,
  exists = fs.existsSync, run = spawnSync } = {}) {
  for (const p of pythonCandidates({ env, platform })) {
    if (isPath(p) && !exists(p)) continue;
    if (run(p, [...args, '-c', code], { cwd, env, stdio: 'ignore' }).status === 0) return p;
  }
  return null;
}

/** The Python to start without checking it first: the first candidate named by a path that exists,
 * or else the usual name on this system. */
export function defaultPython({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (env.ELECTROTAG_PYTHON) return env.ELECTROTAG_PYTHON;
  const found = pythonCandidates({ env, platform }).find((p) => isPath(p) && exists(p));
  return found || (platform === 'win32' ? 'python' : 'python3');
}
