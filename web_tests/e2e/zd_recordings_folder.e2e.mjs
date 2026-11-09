// The recordings folder (docs/using.md, "Your recordings folder"): chosen once on the home page, after which
// Open next recording opens the file from it without asking; a recording that is not there says so and offers
// the usual chooser; Forget forgets it. Where the browser keeps a folder between visits (Chromium), the folder
// is one of this browser's own (its private file system, which a test can fill) standing in for one the person
// chooses; elsewhere (WebKit, and Chromium told it cannot keep one) it is chosen with the folder chooser for the
// visit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signIn, waitForRoute, waitForTraces } from './helpers.mjs';
import { recordEvents, sentEvents } from './l_links.e2e.mjs';

/** The demonstration's example recordings, written into a folder of this browser's private file system named `name`. */
async function fillBrowserFolder(page, name, { leaveOut = null } = {}) {
  await page.evaluate(async ({ name, leaveOut }) => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(name, { recursive: true }); } catch { /* not there yet */ }
    const dir = await (await root.getDirectoryHandle(name, { create: true })).getDirectoryHandle('eeg', { create: true });
    for (const f of await globalThis.ElectroTag.backend.downloadRecordings()) {
      if (f.name === leaveOut) continue;
      const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
      await w.write(f.blob);
      await w.close();
    }
    window.showDirectoryPicker = async () => root.getDirectoryHandle(name); // the folder the person "chooses"
    // kept in memory rather than IndexedDB, which this headless browser cannot read a folder back from (recordings_folder.js)
    if (!(window.__electrotagFolderStore instanceof Map)) window.__electrotagFolderStore = new Map();
  }, { name, leaveOut });
}

/** A new empty folder on disk, for the folder chooser. */
const diskFolder = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'et-recfolder-'));

const nextName = (page) => page.evaluate(() => {
  const items = (globalThis.ElectroTag.assignments && globalThis.ElectroTag.assignments.items) || [];
  const next = items.find((i) => i.status !== 'completed');
  return next ? next.file_name : null;
});

export const tests = [
  {
    name: 'the recordings folder kept between visits: chosen once, the next recording opens from it, a missing one is named, and Forget',
    async run(t) {
      const { assert } = t;
      if (t.browserName !== 'chromium') return; // WebKit has no folder to keep between visits: the next test
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await recordEvents(page);
      const line = page.locator('[data-part="recordings-folder"]');
      await line.waitFor();
      assert.match(await line.textContent(), /Your recordings folder\. Choose the folder where you keep your recordings/);
      await fillBrowserFolder(page, 'My EEG');
      await line.locator('[data-log="recordings-folder-choose"]').click();
      await page.waitForFunction(() => /Your recordings folder: My EEG\./.test(document.querySelector('[data-part="recordings-folder"]').textContent));
      await t.screenshot(page, 'recordings_folder_home');

      // Open next recording: no file to choose, the recording opens from the folder
      await page.click('[data-log="open-next"]');
      await waitForTraces(page);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'annotate');
      const got = (await sentEvents(page)).filter((e) => e.type === 'recordings_folder').map((e) => e.action);
      assert.deepEqual(got, ['chosen', 'found']);
      assert.ok(!(await sentEvents(page)).some((e) => e.type === 'recordings_folder' && JSON.stringify(e).includes('My EEG')), 'no folder names in the log');
      await page.click('[data-log="close"]');
      await page.locator('.dialog button', { hasText: /Close and finish later|Discard and close|Close/ }).first().click();
      await waitForRoute(page, 'home');

      // a recording that is not in the folder: named, with the usual chooser
      const name = await nextName(page);
      await fillBrowserFolder(page, 'My EEG', { leaveOut: name });
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await page.waitForFunction((n) => (document.querySelector('.view.open .result')?.textContent || '').includes(`${n} is not in your recordings folder, My EEG`), name);
      assert.equal(await page.locator('.view.open .result button', { hasText: 'Choose another file' }).count(), 1);
      // the folder's line is on this page too
      assert.match(await page.locator('.view.open [data-part="recordings-folder"]').textContent(), /Your recordings folder: My EEG/);
      await page.locator('.view.open [data-log="recordings-folder-forget"]').click();
      await page.waitForFunction(() => /Choose the folder where you keep your recordings/.test(document.querySelector('.view.open [data-part="recordings-folder"]').textContent));
      assert.equal(await page.evaluate(() => window.__electrotagFolderStore.size), 0, 'forgotten');
    },
  },
  {
    name: 'the recordings folder for this visit, where the browser cannot keep one: chosen with the folder chooser, the next recording opens from it',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ url: null });
      await page.addInitScript(() => { try { delete window.showDirectoryPicker; } catch { /* not there */ } window.showDirectoryPicker = undefined; });
      await page.goto(t.base);
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const line = page.locator('[data-part="recordings-folder"]');
      await line.waitFor();
      assert.match(await line.textContent(), /This browser keeps it for this visit, until the page is closed or reloaded/);
      // the example recordings in a folder on disk
      const root = diskFolder();
      const dir = path.join(root, 'Recordings', 'eeg');
      fs.mkdirSync(dir, { recursive: true });
      const files = await page.evaluate(async () => Promise.all((await globalThis.ElectroTag.backend.downloadRecordings())
        .map(async (f) => ({ name: f.name, bytes: Array.from(new Uint8Array(await f.blob.arrayBuffer())) }))));
      for (const f of files) fs.writeFileSync(path.join(dir, f.name), Buffer.from(f.bytes));
      const chooser = page.waitForEvent('filechooser');
      await line.locator('[data-log="recordings-folder-choose"]').click();
      await (await chooser).setFiles(path.join(root, 'Recordings'));
      await page.waitForFunction(() => /Your recordings folder: Recordings\./.test(document.querySelector('[data-part="recordings-folder"]').textContent));
      await page.click('[data-log="open-next"]');
      await waitForTraces(page);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'annotate');
      fs.rmSync(root, { recursive: true, force: true });
    },
  },
  {
    name: 'an administrator adds the recordings of their recordings folder without choosing it again',
    async run(t) {
      const { assert } = t;
      if (t.browserName !== 'chromium') return;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');
      await page.evaluate(() => { location.hash = '#admin-recordings'; });
      await waitForRoute(page, 'admin-recordings');
      const card = page.locator('.admin-card', { hasText: 'Add recordings from this computer' });
      await card.locator('[data-part="recordings-folder"]').waitFor();
      assert.equal(await card.locator('[data-log="register-my-folder"]').isHidden(), true);
      await fillBrowserFolder(page, 'Dataset');
      await card.locator('[data-log="recordings-folder-choose"]').click();
      await page.waitForFunction(() => !document.querySelector('[data-log="register-my-folder"]').hidden);
      assert.equal(await card.locator('[data-log="register-my-folder"]').textContent(), 'Use my recordings folder (Dataset)');
      await card.locator('[data-log="register-my-folder"]').click();
      await page.waitForSelector('[data-log="register"]', { timeout: 60000 });
      assert.match(await page.innerText('.admin-review'), /Found 3 recordings/);
      assert.match(await page.innerText('.admin-review'), /eeg\/sub-demo01_task-rest_eeg\.edf/);
    },
  },
];
