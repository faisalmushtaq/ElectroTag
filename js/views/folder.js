// The recordings folder as people see it (docs/using.md, "Your recordings folder"; js/data/recordings_folder.js):
// the line that chooses, changes or forgets it, on the home page, the page that opens recordings and the
// admin area's Add recordings, and opening the expected recording from it. The interaction log records
// what was done and whether the recording was found, never the folder's or the files' names.

import { h, clear } from '../ui/dom.js';
import { logger } from '../log/logger.js';
import { CAN_CHOOSE_FOLDER } from '../util.js';
import { ownerKey } from '../data/device_store.js';
import { RecordingsFolder, folderMode } from '../data/recordings_folder.js';

/** The signed-in person's recordings folder in this study (filed as their kept recordings are), or null before signing in. */
export function recordingsFolder(app) {
  if (!app.me || !app.backend) return null;
  const study = app.me.study || {};
  const owner = ownerKey({ backend: app.backend.kind || '', server: app.backend.kind === 'server' ? app.backend.server || '' : '',
    studyId: study.study_id || study.name || '', annotatorId: app.me.annotator_id || '' });
  if (!app._recordingsFolder || app._recordingsFolder.owner !== owner) {
    app._recordingsFolder = new RecordingsFolder({ owner, mode: folderMode(globalThis, CAN_CHOOSE_FOLDER) });
  }
  return app._recordingsFolder;
}

/** The browser's folder chooser, for a folder kept for this visit: resolves to the files chosen ([] if none). */
function chooseWithInput() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, webkitdirectory: true, hidden: true, 'data-log': 'recordings-folder-input' });
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...input.files]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

/** Choose (or change) the folder; true when one was chosen. */
export async function chooseFolder(app) {
  const f = recordingsFolder(app);
  if (!f || !f.available) return false;
  const name = await f.choose({ visitInput: chooseWithInput });
  if (name) logger.event('recordings_folder', { action: 'chosen', mode: f.mode });
  return Boolean(name);
}

const WHAT = 'ElectroTag looks there for each recording you open, so that you need not choose its file.';

/**
 * The line about the folder: what it is and its buttons, filled in as the browser answers. `onChange`
 * runs after the folder is chosen, changed or forgotten. Null where the browser has no folder chooser (an iPad).
 */
export function folderLine(app, { onChange = null, compact = false } = {}) {
  const f = recordingsFolder(app);
  if (!f || !f.available) return null;
  const line = h(`div.folder-line${compact ? '.compact' : ''}`, { 'data-part': 'recordings-folder' });
  const fill = async () => {
    const st = await f.state();
    clear(line);
    const choose = h('button.btn.small', { type: 'button', 'data-log': 'recordings-folder-choose', onclick: async () => {
      if (await chooseFolder(app)) { await fill(); if (onChange) onChange(); }
    } }, st ? 'Change…' : 'Choose the folder…');
    if (!st) {
      line.append(h('p', {}, h('b', {}, 'Your recordings folder. '), 'Choose the folder where you keep your recordings: ', WHAT,
        f.mode === 'visit' ? ' This browser keeps it for this visit, until the page is closed or reloaded.' : ''), h('div.btn-row', {}, choose));
      return;
    }
    const forget = h('button.btn.small.quiet', { type: 'button', 'data-log': 'recordings-folder-forget', onclick: async () => {
      await f.forget();
      logger.event('recordings_folder', { action: 'forgotten', mode: f.mode });
      await fill();
      if (onChange) onChange();
    } }, 'Forget');
    line.append(h('p', {}, h('b', {}, 'Your recordings folder: '), h('span.folder-name', {}, st.name), '. ', WHAT,
      f.mode === 'visit' ? ' This browser keeps it until the page is closed or reloaded.'
        : st.permission === 'granted' ? '' : ' The browser asks once whether ElectroTag may read it again; choose Allow on every visit to be asked no more.'),
    h('div.btn-row', {}, choose, forget));
  };
  fill();
  line.refresh = fill;
  return line;
}

/**
 * Open the recording a page expects (`name`, its file name) from the folder: `view` is the open view
 * (js/views/open.js), whose handle() takes the files and whose messages say what happened. Resolves to true
 * when the files were found and handed on.
 */
export async function openFromFolder(app, view, name, { keep = false } = {}) {
  const f = recordingsFolder(app);
  if (!f || !f.available || !name) return false;
  let got;
  try { got = await f.find(name); } catch { got = null; }
  if (!got || app.openView !== view) return false;
  const st = await f.state();
  const where = st ? st.name : 'your recordings folder';
  if (got.files) {
    logger.event('recordings_folder', { action: 'found', mode: f.mode });
    view.handle(got.files, true, { kind: 'folder', keep });
    return true;
  }
  if (got.permission) {
    const allow = h('button.btn.primary', { type: 'button', 'data-log': 'recordings-folder-allow', onclick: async () => {
      const ok = await f.allow();
      logger.event('recordings_folder', { action: ok ? 'allowed' : 'refused', mode: f.mode });
      if (ok) await openFromFolder(app, view, name, { keep });
      else view.showMessage(`The browser did not allow ElectroTag to read ${where}. Choose the file below instead.`, [view.chooseAgainButton()]);
    } }, 'Open it from my recordings folder');
    view.showMessage(`Your recordings folder, ${where}, is ready. The browser asks once whether ElectroTag may read it again on this visit.`, [allow]);
    return false;
  }
  if (got.gone) {
    logger.event('recordings_folder', { action: 'gone', mode: f.mode });
    view.showMessage(`Your recordings folder, ${where}, can no longer be found here: it may have been moved or renamed. Choose it again, or choose the file below.`,
      [h('button.btn', { type: 'button', 'data-log': 'recordings-folder-again', onclick: async () => { if (await chooseFolder(app)) await openFromFolder(app, view, name, { keep }); } }, 'Choose the folder again…'),
        view.chooseAgainButton(false)]);
    return false;
  }
  logger.event('recordings_folder', { action: 'missing', mode: f.mode });
  view.showMessage(`${name} is not in your recordings folder, ${where}. Choose it below, or change the folder.`, [view.chooseAgainButton()]);
  return false;
}
