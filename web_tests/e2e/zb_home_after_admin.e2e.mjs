// An administrator who gives themselves recordings in the admin area finds them under My recordings straight
// away (docs/web/admin.md, "Getting in"): leaving the admin or expert area asks the study for
// the person's recordings again, rather than showing the list read at sign-in. In the sandbox and on the real
// study server. On the study server ADMIN, who has no Annotator role and has not answered the sign-up
// questionnaire, is asked it first now that they annotate (docs/web/admin.md, "Questionnaire"); the sandbox's ADMIN
// has the example answers.
import { answerQuestionnaire, signIn, waitForRoute } from './helpers.mjs';

const PASSWORD = 'electrotag';
const hex = (n) => n.toString(16).padStart(32, '0');

/** Hand the recordings `rids`, as a dataset of their own, to `aid` through the page's own back end. */
async function handOutToSelf(page, rids, aid) {
  const call = (op, body) => page.evaluate(([o, b]) => globalThis.ElectroTag.backend.admin(o, b), [op, body]);
  await call('dataset_create', { request_id: hex(0xa1), dataset_id: 'self-ds', name: 'For myself' });
  await call('recordings_move', { recording_ids: rids, dataset_id: 'self-ds' });
  await call('handout_create', { request_id: hex(0xa2), target: { kind: 'dataset', id: 'self-ds' }, people: [aid] });
}

/** Two study recordings not yet among ADMIN's own (as read at sign-in). */
async function notYetMine(page) {
  const rids = await page.evaluate(async () => {
    const mine = new Set((globalThis.ElectroTag.assignments.items || []).map((i) => i.recording_id));
    const all = (await globalThis.ElectroTag.backend.admin('recordings_list', { scope: 'study' })).recordings.map((r) => r.recording_id);
    return all.filter((r) => !mine.has(r)).slice(0, 2);
  });
  if (rids.length < 2) throw new Error(`too few recordings to hand out for this test: ${rids.join(', ')}`);
  return rids;
}

/** The recordings listed on the home page. */
const listed = (page) => page.evaluate(() => [...document.querySelectorAll('.recordings-card table.list tbody tr:not(.group-row)')].length);

async function leaveAdminAndCheck(t, page, n, { asked = false } = {}) {
  const { assert } = t;
  const before = await page.evaluate(() => (globalThis.ElectroTag.assignments.items || []).length);
  await page.click('[data-log="leave-admin"]');
  // My recordings, or the questionnaire first (the page reads the recordings and the questionnaire's status meanwhile)
  await page.waitForSelector('.recordings-card, form.q-form', { timeout: 30000 });
  const q = await page.evaluate(() => globalThis.ElectroTag.me.questionnaire);
  if (asked && !q.answered) {
    assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'questionnaire', 'an administrator who now annotates answers it first');
    await answerQuestionnaire(page, { name: 'Study administrator', email: 'admin@example.org' });
  } else {
    assert.equal(await page.evaluate(() => globalThis.ElectroTag.route), 'home', 'straight to My recordings');
  }
  await waitForRoute(page, 'home', 30000);
  await page.waitForSelector('.recordings-card');
  await page.click('[data-tab="todo"]').catch(() => {}); // the To do tab, where the list has one
  const items = await page.evaluate(() => globalThis.ElectroTag.assignments.items.map((i) => i.recording_id));
  assert.equal(items.length, before + n, `the recordings handed out are in the list: ${items.join(', ')}`);
  assert.ok(await listed(page) >= n, 'and on the page');
}

export const tests = [
  {
    name: 'in the sandbox: ADMIN hands a dataset to themselves, then My recordings lists it without a reload',
    async run(t) {
      const page = await t.newPage({ width: 1440, height: 1000 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && /^admin/.test(globalThis.ElectroTag.route || ''));
      await handOutToSelf(page, await notYetMine(page), 'ADMIN');
      await leaveAdminAndCheck(t, page, 2);
    },
  },
  {
    name: 'on the study server: ADMIN hands a dataset to themselves, then My recordings lists it without a reload',
    needs: 'study',
    async run(t) {
      const page = await t.newPage({ url: t.study.base, width: 1440, height: 1000 });
      await signIn(page, 'ADMIN', PASSWORD);
      await page.waitForFunction(() => globalThis.ElectroTag && /^admin/.test(globalThis.ElectroTag.route || ''));
      await handOutToSelf(page, await notYetMine(page), 'ADMIN');
      await leaveAdminAndCheck(t, page, 2, { asked: true });
    },
  },
];
