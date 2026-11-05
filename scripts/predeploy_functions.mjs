// Runs scripts/vendor_functions.py before Firebase deploys the Cloud Functions (the predeploy step
// in firebase.json), with whichever Python the computer has.
//
//     node scripts/predeploy_functions.mjs [functions_folder]
//
// Firebase's tool runs on Node.js, so Node.js is always there when a deployment starts, while the
// name of Python differs: macOS and Linux have python3, Windows has python or the py launcher.
// The functions' own environment (venv in the functions folder, which every deployment needs) is
// tried first, then the usual names.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FUNCTIONS = path.join(HERE, '..', 'electrotag', 'web', 'firebase', 'functions');

/** The Pythons to try, in order, for the functions folder on this platform. */
export function pythonCandidates(functionsDir, platform = process.platform) {
  if (platform === 'win32') {
    return [path.win32.join(functionsDir, 'venv', 'Scripts', 'python.exe'), 'py', 'python', 'python3'];
  }
  return [path.posix.join(functionsDir, 'venv', 'bin', 'python'), 'python3', 'python'];
}

/**
 * Runs the vendoring script with the first Python that starts. Returns the exit code: the script's
 * own, or 1 when no Python could be started.
 */
export function vendor(functionsDir = DEFAULT_FUNCTIONS, { platform = process.platform, run = spawnSync, exists = fs.existsSync, log = console.error } = {}) {
  const script = path.join(HERE, 'vendor_functions.py');
  for (const python of pythonCandidates(functionsDir, platform)) {
    if (path.isAbsolute(python) || path.win32.isAbsolute(python)) {
      if (!exists(python)) continue;
    }
    const res = run(python, [script, functionsDir], { stdio: 'inherit' });
    if (res.error) continue; // not installed under this name
    // 9009: the Windows stand-in that offers Python from the Microsoft Store instead of running it
    if (platform === 'win32' && res.status === 9009) continue;
    return res.status === null ? 1 : res.status;
  }
  log('Python could not be found to prepare the functions. Make the functions\' environment first, as in step 8 of '
    + 'docs/firebase.md (electrotag/web/firebase/functions/venv), then deploy again.');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = vendor(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FUNCTIONS);
}
