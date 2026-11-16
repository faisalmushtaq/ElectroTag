// Looking for training recordings (docs/admin_area.md, "Looking for training recordings"): on the real study server,
// the study team lets E01 look through the built-in dataset; E01 finds it in Find training recordings, opens a
// recording from this computer, marks an artifact, rates it Yes, keeps a note and asks for it; none of this reaches the
// results or E01's interaction log; the study team approves the request into the example set from Training, and the
// recording awaits annotation on the set's page. In the demonstration the cards say that they need a study server, the
// coverage of the artifact types is shown, and Study settings keeps the types chosen.
import fs from 'node:fs';
import path from 'node:path';
import { drag, eegPoint, signIn, waitForRoute, waitForTraces } from './helpers.mjs';

const PASSWORD = 'electrotag';
const NOTE = 'Okapi: clear blinks in the first minute';

async function api(t, token, p, body) {
  const res = await fetch(`${t.study.base}api/v1${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ElectroTag': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${p}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function filesFor(dir, fileName) {
  const stem = fileName.replace(/\.(vhdr|edf|bdf)$/i, '');
  const found = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.startsWith(stem) && /\.(vhdr|vmrk|eeg|edf|bdf)$/i.test(f)) found.push(p);
    }
  })(path.join(dir, 'recordings'));
  return found;
}

/** Every file below `dir` whose contents hold `text`. */
function filesHolding(dir, text) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (fs.readFileSync(p).includes(text)) out.push(p);
    }
  })(dir);
  return out;
}

/** How often the recording appears in E01's interaction logs. */
function inLogs(t, rid) {
  const dir = path.join(t.study.dir, 'study', 'Annotated_Events', 'interaction_logs', 'annotator-E01');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((n, f) => n + fs.readFileSync(path.join(dir, f), 'utf8').split(rid).length - 1, 0);
}

export const tests = [
  {
    name: 'on the study server: an expert looks through a dataset, rates, notes and asks for a recording, and the study team approves it into a set',
    needs: 'study',
    async run(t) {
      const { assert } = t;
      const file = 'sub-003_task-rest_eeg.edf';
      const admin = (await api(t, null, '/login', { annotator_id: 'ADMIN', password: PASSWORD })).token;
      const given = await api(t, admin, '/admin/browse_access_set', { dataset_id: 'study-recordings', annotator_id: 'E01', access: true });
      assert.ok(given.grants.some((g) => g.annotator_id === 'E01' && g.dataset_id === 'study-recordings'));
      const e01 = (await api(t, null, '/login', { annotator_id: 'E01', password: PASSWORD })).token;
      const listed = await api(t, e01, '/expert/browse_recordings_list', { dataset_id: 'study-recordings' });
      const row = listed.recordings.find((r) => r.file_name === file);
      assert.ok(row, `${file} is among the dataset's recordings`);
      const rid = row.recording_id;
      const logsBefore = inLogs(t, rid);

      const page = await t.newPage({ url: t.study.base, width: 1440, height: 900 });
      await signIn(page, 'E01', PASSWORD);
      await page.waitForFunction(() => { const a = globalThis.ElectroTag; return a && a.me && a.isExpert && /^(home|expert)/.test(a.route || ''); }, null, { timeout: 30000 });
      await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-browse'));
      await page.waitForSelector('section[data-section="browse"] [data-log="browse-dataset"][data-dataset="study-recordings"]');
      assert.equal(await page.locator('.expert-nav a[aria-current="page"]').textContent(), 'Find training recordings');
      await page.click('[data-log="browse-dataset"][data-dataset="study-recordings"]');
      await page.waitForSelector('section[data-section="browse"] table');
      await t.screenshot(page, 'find_training_recordings');

      // Open it from this computer, checked against the study's copy; the interaction log is paused from here on.
      await page.evaluate(async (r) => (await import(new URL('js/expert/browse_pass.js', location.href).href)).startBrowse(globalThis.ElectroTag, r), rid);
      await waitForRoute(page, 'expert-browsing');
      await page.setInputFiles('input[data-log="file-input"]', filesFor(t.study.dir, file));
      await page.waitForSelector('.browse-pass', { timeout: 30000 });
      await waitForTraces(page);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.readOnly), false);
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.over.focus());
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 2.0), await eegPoint(page, 2.5));
      await page.click('.browse-rating [data-rating="yes"]');
      await page.fill('.browse-note', NOTE);
      await page.waitForFunction(() => { const ws = globalThis.ElectroTag.ws; return ws && ws.store.size === 1 && !ws.s.unsent && ws.pass.note === ws.pass.sentNote && ws.pass.rating === 'yes'; },
        null, { timeout: 15000 });
      assert.equal(await page.getAttribute('.browse-status', 'data-state'), 'saved');
      await page.click('[data-log="browse-ask"]');
      await page.waitForSelector('[data-log="browse-withdraw"]');
      await t.screenshot(page, 'looking_for_training');
      await page.click('.ws-header button[data-log="close"]');
      await waitForRoute(page, 'expert-browse');
      await page.evaluate(() => globalThis.ElectroTag.flushLog());

      const mine = await api(t, e01, '/expert/browse_recording_get', { recording_id: rid });
      assert.equal(mine.mine.rating, 'yes');
      assert.equal(mine.mine.note, NOTE);
      assert.equal(mine.mine.n_annotations, 1);
      assert.equal(mine.request.status, 'pending');
      assert.deepEqual(filesHolding(path.join(t.study.dir, 'study', 'Annotated_Events'), mine.mine.annotations[0].annotation_id), [],
        'the mark is in no result file, log or export');
      assert.deepEqual(filesHolding(path.join(t.study.dir, 'study', 'Annotated_Events'), NOTE), []);
      assert.equal(inLogs(t, rid), logsBefore, 'looking for training recordings is not in the interaction log');

      // The study team: the request in Training, approved into the example set, then awaiting annotation there.
      const team = await t.newPage({ url: t.study.base, width: 1440, height: 900 });
      await signIn(team, 'ADMIN', PASSWORD);
      await team.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route && /^admin/.test(globalThis.ElectroTag.route), null, { timeout: 30000 });
      await team.evaluate(() => globalThis.ElectroTag.showAdmin('admin-training'));
      await waitForRoute(team, 'admin-training');
      const card = team.locator('.card', { hasText: 'Recordings the experts asked for' });
      await card.locator('tbody tr', { hasText: file }).waitFor({ timeout: 15000 });
      const requestRow = card.locator('tbody tr', { hasText: file }).filter({ hasText: 'E01' });
      assert.match(await requestRow.textContent(), /Yes/);
      assert.match(await requestRow.textContent(), /1 mark/);
      assert.doesNotMatch(await card.textContent(), /Okapi/, 'the expert\'s note stays their own');
      await requestRow.locator('input[type="checkbox"]').check();
      await card.locator('select[data-log="requests-set"]').selectOption('example');
      await card.locator('[data-log="requests-approve"]').click();
      await team.waitForFunction(() => /approved: the recordings await annotation in example/.test(document.querySelector('section.admin-section[data-section="training"]').textContent), null, { timeout: 15000 });
      await team.locator('.set-item', { hasText: 'example' }).first().click();
      const waiting = team.locator('.card', { hasText: 'Recordings approved into this set' });
      await waiting.locator('tbody tr', { hasText: file }).waitFor({ timeout: 15000 });
      assert.match(await waiting.textContent(), /E01 \(Yes\)/);
      await t.screenshot(team, 'training_awaiting_annotation');
      const back = await api(t, e01, '/expert/browse_recording_get', { recording_id: rid });
      assert.equal(back.request.status, 'approved');
      assert.equal(back.request.set_id, 'example');
    },
  },
  {
    name: 'in the demonstration: the study team\'s cards say they need a study server, the coverage is shown, and Study settings keeps the types chosen',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && /^admin/.test(globalThis.ElectroTag.route || ''), null, { timeout: 30000 });
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-training'));
      await waitForRoute(page, 'admin-training');
      const requests = page.locator('.card', { hasText: 'Recordings the experts asked for' });
      await requests.locator('p.note', { hasText: 'needs a study server or Firebase' }).waitFor();
      const coverage = page.locator('.card', { hasText: 'Artifact types that need training material' });
      await coverage.locator('table').waitFor();
      assert.equal(await coverage.locator('tbody tr').count(), 9, 'the nine types on the number keys until the study chooses');

      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-settings'));
      await waitForRoute(page, 'admin-settings');
      const list = page.locator('fieldset.admin-checks', { hasText: 'Artifact types that need training material' });
      await list.waitFor();
      await list.locator('button', { hasText: 'None' }).click();
      for (const type of ['EMG-artifact', 'Chewing-artifact']) await list.locator('label.check-item', { hasText: type }).first().locator('input').check();
      await page.click('[data-log="settings-save"]');
      await page.waitForFunction(() => /The settings are saved/.test(document.querySelector('.sticky-save').textContent), null, { timeout: 15000 });
      const saved = await page.evaluate(async () => (await globalThis.ElectroTag.backend.admin('settings_get', {})).settings.training.required_types);
      assert.deepEqual([...saved].sort(), ['Chewing-artifact', 'EMG-artifact']);
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-training'));
      await waitForRoute(page, 'admin-training');
      await coverage.locator('table').waitFor();
      assert.equal(await coverage.locator('tbody tr').count(), 2);

      // The expert area's section answers that it needs a study server too.
      await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-browse'));
      await page.waitForFunction(() => /needs a study server or Firebase/.test((document.querySelector('section.admin-section[data-section="browse"]') || {}).textContent || ''), null, { timeout: 15000 });
    },
  },
];
