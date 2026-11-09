// The recordings folder (docs/using.md, "Your recordings folder"): a folder on this computer that a person
// chooses once, where ElectroTag then finds each recording they open, so that they need not choose the file
// every time. The files are read where they are, in the browser, as a chosen file is; nothing is copied.
//
// Where the browser lets a page keep a folder (Chrome and Edge on a computer: the File System Access API's
// showDirectoryPicker), the folder's handle is kept in this browser's IndexedDB, filed under the study and
// the sign-in like the recordings kept on this device (device_store.js ownerKey), and on a later visit the
// browser asks once whether the page may read it again ("Allow on every visit" makes that the last time).
// Elsewhere (Safari and Firefox on a computer) the folder is chosen with the browser's folder chooser and
// kept for this visit only, in memory: until the page is closed or reloaded. On an iPad, which has no
// folder chooser, there is no recordings folder; recordings kept on this device stand in for it.
//
// The functions before RecordingsFolder are pure and tested in Node (web_tests/unit/ui_recordings_folder.test.mjs).

/** The files a recording may need from its folder: the EEG, BrainVision's three, and the BIDS sidecars (.tsv, .json). */
const WANTED = /\.(edf|bdf|rec|vhdr|vmrk|eeg|tsv|json)$/i;
/** How deep in the folder a recording is looked for (a BIDS dataset keeps it in sub-01/ses-1/eeg, three folders down). */
export const MAX_DEPTH = 6;
/** Folders never looked into: hidden ones, and the derivatives BIDS keeps beside the raw data. */
const SKIP_DIR = /^(\.|derivatives$|sourcedata$|node_modules$)/i;

/** Which way this browser keeps a folder: 'kept' (between visits), 'visit' (this visit only) or null (none). */
export function folderMode(env = globalThis, canChooseFolder = true) {
  if (env && typeof env.showDirectoryPicker === 'function' && env.indexedDB) return 'kept';
  return canChooseFolder ? 'visit' : null;
}

/**
 * The files of the recording `name` among files chosen with the folder chooser (each with its
 * webkitRelativePath): those in the same folder as the file of that name that ElectroTag may need. Null
 * when no file has that name; the first folder holding it when several do.
 */
export function filesBesideIn(files, name) {
  const dirOf = (f) => String(f.webkitRelativePath || f.name).split('/').slice(0, -1).join('/');
  const hit = [...files].filter((f) => f.name === name).sort((a, b) => dirOf(a).split('/').length - dirOf(b).split('/').length
    || (dirOf(a) < dirOf(b) ? -1 : 1))[0];
  if (!hit) return null;
  const dir = dirOf(hit);
  return [...files].filter((f) => dirOf(f) === dir && WANTED.test(f.name));
}

/**
 * The files of the recording `name` in a kept folder (a FileSystemDirectoryHandle): looked for breadth
 * first, to MAX_DEPTH folders down, and returned with the files beside it that ElectroTag may need; null
 * when it is not there.
 */
export async function findInHandle(root, name, { maxDepth = MAX_DEPTH } = {}) {
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      const entries = [];
      for await (const entry of dir.values()) entries.push(entry);
      if (entries.some((e) => e.kind === 'file' && e.name === name)) {
        const files = [];
        for (const e of entries) if (e.kind === 'file' && WANTED.test(e.name)) files.push(await e.getFile());
        return files;
      }
      for (const e of entries) if (e.kind === 'directory' && !SKIP_DIR.test(e.name)) next.push(e);
    }
    next.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    level = next;
  }
  return null;
}

/** Every recording file of a kept folder, for the admin area to read as if the folder had been chosen. */
export async function allFilesInHandle(root, { maxDepth = MAX_DEPTH, limit = 20000 } = {}) {
  const out = [];
  const walk = async (dir, path, depth) => {
    for await (const e of dir.values()) {
      if (out.length >= limit) return;
      if (e.kind === 'file' && WANTED.test(e.name)) {
        const f = await e.getFile();
        try { Object.defineProperty(f, 'webkitRelativePath', { value: `${path}${e.name}` }); } catch { /* read-only in this browser */ }
        out.push(f);
      } else if (e.kind === 'directory' && depth < maxDepth && !SKIP_DIR.test(e.name)) {
        await walk(e, `${path}${e.name}/`, depth + 1);
      }
    }
  };
  await walk(root, `${root.name}/`, 0);
  return out;
}

// ------------------------------------------------------------------ the browser's storage
const DB_NAME = 'electrotag-folders';
const DB_STORE = 'folders';

function db(env) {
  return new Promise((resolve, reject) => {
    const req = env.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(env, mode, fn) {
  // The browser tests keep the handle in memory instead (web_tests/e2e/zd_recordings_folder.e2e.mjs): Playwright's
  // headless Chromium closes when it reads a folder's handle back from IndexedDB.
  const mem = env.__electrotagFolderStore;
  if (mem instanceof Map) {
    const s = { get: (k) => ({ result: mem.get(k) }), put: (v, k) => { mem.set(k, v); return {}; }, delete: (k) => { mem.delete(k); return {}; } };
    const r = fn(s);
    return r && 'result' in r ? r.result : undefined;
  }
  const d = await db(env);
  try {
    return await new Promise((resolve, reject) => {
      const t = d.transaction(DB_STORE, mode);
      const r = fn(t.objectStore(DB_STORE));
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { d.close(); }
}

/** This visit's folders, chosen where the browser cannot keep one: owner -> {name, files}. */
const VISIT = new Map();

/**
 * One person's recordings folder in this study (`owner`, device_store.js ownerKey), kept the way this
 * browser allows (`mode`, folderMode).
 */
export class RecordingsFolder {
  constructor({ owner, mode, env = globalThis }) {
    this.owner = owner;
    this.mode = mode;
    this.env = env;
  }

  get available() { return Boolean(this.mode); }

  /** The folder chosen, or null: {name, mode, permission ('granted', 'prompt' or 'denied'; always 'granted' for this visit)}. */
  async state() {
    if (this.mode === 'visit') {
      const v = VISIT.get(this.owner);
      return v ? { name: v.name, mode: 'visit', permission: 'granted' } : null;
    }
    if (this.mode !== 'kept') return null;
    let handle;
    try { handle = await tx(this.env, 'readonly', (s) => s.get(this.owner)); } catch { return null; }
    if (!handle) return null;
    let permission = 'prompt';
    try { permission = await handle.queryPermission({ mode: 'read' }); } catch { /* an older browser: ask */ }
    return { name: handle.name, mode: 'kept', permission };
  }

  /** Choose the folder (a press of the person's: the browser's chooser needs one). Resolves to its name, or null if none was chosen. */
  async choose({ visitInput = null } = {}) {
    if (this.mode === 'kept') {
      let handle;
      try {
        handle = await this.env.showDirectoryPicker({ id: 'electrotag-recordings', mode: 'read' });
      } catch (exc) {
        if (exc && exc.name === 'AbortError') return null;
        throw exc;
      }
      await tx(this.env, 'readwrite', (s) => s.put(handle, this.owner));
      return handle.name;
    }
    if (this.mode === 'visit' && visitInput) {
      const files = await visitInput();
      if (!files || !files.length) return null;
      const name = String(files[0].webkitRelativePath || '').split('/')[0] || 'the folder';
      VISIT.set(this.owner, { name, files: [...files] });
      return name;
    }
    return null;
  }

  async forget() {
    VISIT.delete(this.owner);
    if (this.mode === 'kept') { try { await tx(this.env, 'readwrite', (s) => s.delete(this.owner)); } catch { /* nothing kept */ } }
  }

  /** Ask the browser again whether the page may read the kept folder (a press of the person's). True when it may. */
  async allow() {
    if (this.mode !== 'kept') return true;
    const handle = await tx(this.env, 'readonly', (s) => s.get(this.owner));
    if (!handle) return false;
    try { return (await handle.requestPermission({ mode: 'read' })) === 'granted'; } catch { return false; }
  }

  /**
   * The files of the recording `name` in the folder: {files} when it is there, {missing: true} when it is not,
   * {permission: 'prompt' | 'denied'} when the browser must be asked first, or null without a folder.
   */
  async find(name) {
    if (this.mode === 'visit') {
      const v = VISIT.get(this.owner);
      if (!v) return null;
      const files = filesBesideIn(v.files, name);
      return files ? { files } : { missing: true };
    }
    if (this.mode !== 'kept') return null;
    const handle = await tx(this.env, 'readonly', (s) => s.get(this.owner)).catch(() => null);
    if (!handle) return null;
    let permission = 'prompt';
    try { permission = await handle.queryPermission({ mode: 'read' }); } catch { /* ask */ }
    if (permission !== 'granted') return { permission };
    try {
      const files = await findInHandle(handle, name);
      return files ? { files } : { missing: true };
    } catch (exc) {
      // the folder was moved, renamed or deleted since it was chosen
      if (exc && (exc.name === 'NotFoundError' || exc.name === 'NotAllowedError')) return { gone: true };
      throw exc;
    }
  }

  /** Every recording file of the folder (for the admin area), or null without one the page may read. */
  async allFiles() {
    if (this.mode === 'visit') { const v = VISIT.get(this.owner); return v ? v.files.filter((f) => WANTED.test(f.name)) : null; }
    if (this.mode !== 'kept') return null;
    const handle = await tx(this.env, 'readonly', (s) => s.get(this.owner)).catch(() => null);
    if (!handle) return null;
    let permission = 'prompt';
    try { permission = await handle.queryPermission({ mode: 'read' }); } catch { /* ask */ }
    if (permission !== 'granted' && !(await this.allow())) return null;
    return allFilesInHandle(handle);
  }
}
