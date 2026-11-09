// The recordings folder (js/data/recordings_folder.js): which way a browser keeps it, and finding a recording,
// with the files beside it, in a folder chosen for this visit and in a kept folder (a stand-in for the browser's
// FileSystemDirectoryHandle).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DEPTH, allFilesInHandle, filesBesideIn, findInHandle, folderMode } from '../../electrotag/web/static/js/data/recordings_folder.js';

/** A file as the folder chooser gives it. */
const file = (path) => ({ name: path.split('/').pop(), webkitRelativePath: path, size: 1 });

/** A folder as the File System Access API gives it: {name: subfolder | true for a file}. */
function folder(name, tree) {
  return {
    kind: 'directory', name,
    async *values() {
      for (const [n, v] of Object.entries(tree)) {
        yield v === true ? { kind: 'file', name: n, getFile: async () => ({ name: n, size: 1 }) } : folder(n, v);
      }
    },
  };
}

test('a folder is kept between visits where the browser allows, for the visit where it can choose one, and not at all on an iPad', () => {
  assert.equal(folderMode({ showDirectoryPicker() {}, indexedDB: {} }, true), 'kept');
  assert.equal(folderMode({ indexedDB: {} }, true), 'visit');
  assert.equal(folderMode({}, false), null);
});

test('in a folder chosen for this visit: the recording and the files beside it that it may need', () => {
  const files = [
    file('study/sub-01/eeg/sub-01_task-rest_eeg.vhdr'), file('study/sub-01/eeg/sub-01_task-rest_eeg.vmrk'),
    file('study/sub-01/eeg/sub-01_task-rest_eeg.eeg'), file('study/sub-01/eeg/sub-01_electrodes.tsv'),
    file('study/sub-01/eeg/sub-01_task-rest_events.tsv'), file('study/sub-01/eeg/notes.txt'),
    file('study/sub-02/eeg/sub-02_task-rest_eeg.edf'),
  ];
  assert.deepEqual(filesBesideIn(files, 'sub-01_task-rest_eeg.vhdr').map((f) => f.name),
    ['sub-01_task-rest_eeg.vhdr', 'sub-01_task-rest_eeg.vmrk', 'sub-01_task-rest_eeg.eeg', 'sub-01_electrodes.tsv', 'sub-01_task-rest_events.tsv']);
  assert.deepEqual(filesBesideIn(files, 'sub-02_task-rest_eeg.edf').map((f) => f.name), ['sub-02_task-rest_eeg.edf']);
  assert.equal(filesBesideIn(files, 'sub-03_task-rest_eeg.edf'), null);
  // the same name twice: the copy nearest the top
  const twice = [file('a/x/b/rec.edf'), file('a/rec.edf'), file('a/other.edf')];
  assert.equal(filesBesideIn(twice, 'rec.edf')[0].webkitRelativePath, 'a/rec.edf');
});

test('in a kept folder: found breadth first, hidden and derived folders left out, as deep as a BIDS dataset goes', async () => {
  const root = folder('EEG', {
    '.cache': { 'rec.edf': true },
    derivatives: { 'sub-01_task-rest_eeg.edf': true },
    'sub-01': { 'ses-1': { eeg: { 'sub-01_task-rest_eeg.edf': true, 'sub-01_electrodes.tsv': true, 'sub-01_coordsystem.json': true, 'readme.md': true } } },
    'old.edf': true,
  });
  const got = await findInHandle(root, 'sub-01_task-rest_eeg.edf');
  assert.deepEqual(got.map((f) => f.name).sort(), ['sub-01_coordsystem.json', 'sub-01_electrodes.tsv', 'sub-01_task-rest_eeg.edf']);
  assert.equal(await findInHandle(root, 'rec.edf'), null, 'not in hidden folders');
  assert.deepEqual((await findInHandle(root, 'old.edf')).map((f) => f.name), ['old.edf']);
  // deeper than MAX_DEPTH: not looked for
  let deep = { 'far.edf': true };
  for (let i = 0; i <= MAX_DEPTH; i++) deep = { [`d${i}`]: deep };
  assert.equal(await findInHandle(folder('top', deep), 'far.edf'), null);
});

test('every recording file of a kept folder, with its path inside it, for the admin area', async () => {
  const root = folder('dataset', { 'sub-01': { eeg: { 'sub-01_task-rest_eeg.edf': true, 'sub-01_task-rest_channels.tsv': true } }, 'README': true });
  const all = await allFilesInHandle(root);
  assert.deepEqual(all.map((f) => f.webkitRelativePath), ['dataset/sub-01/eeg/sub-01_task-rest_eeg.edf', 'dataset/sub-01/eeg/sub-01_task-rest_channels.tsv']);
});
