// Training sets in the expert area (docs/admin_area.md, "The expert area" and "Training"): an expert sets up
// a reference set as an administrator does, the list of recordings to add offers only those someone has
// saved annotations of (every registered one for an annotation file), and the rest of the admin area stays
// closed to them.
import { signIn, waitForRoute } from './helpers.mjs';

export const tests = [
  {
    name: 'an expert sets up a reference set in the expert area; only annotated recordings are offered for it',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'E01');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');
      await page.evaluate(() => globalThis.ElectroTag.showExpert('expert-training'));
      await waitForRoute(page, 'expert-training');
      const section = page.locator('.admin-section[data-section="training"]');
      await section.locator('.set-list .set-item').first().waitFor();
      assert.equal(await page.locator('.expert-nav a[aria-current="page"]').textContent(), 'Training sets');

      // A new set: the expert gets as far as an administrator does (the sandbox makes sets only on a study
      // server; tests/test_web_expert_training.py makes one there and finds it audited under the expert).
      const newSet = section.locator('details.admin-details', { has: page.locator('summary', { hasText: 'New reference set' }) });
      await newSet.locator('summary').click();
      await newSet.locator('form input').first().fill('expert-pilot');
      await newSet.locator('form input').nth(1).fill('Expert pilot');
      await page.click('[data-log="set-create"]');
      await page.waitForFunction(() => /needs a study server or Firebase/.test(document.querySelector('.admin-section[data-section="training"]').textContent));
      assert.doesNotMatch(await section.textContent(), /Only study administrators/);

      // The recordings offered: those someone has saved annotations of.
      const recs = await page.evaluate(async () => (await globalThis.ElectroTag.backend.admin('recordings_list', {})).recordings);
      const setId = await page.evaluate(() => document.querySelector('.set-item[aria-current="true"] .caption').textContent.split(' ')[0]);
      const mine = recs.filter((r) => (r.scope === 'study' || r.scope === `set:${setId}`) && !r.retired);
      const key = (r) => `${r.scope}|${r.recording_id}`;
      const sets = await page.evaluate(async () => (await globalThis.ElectroTag.backend.admin('sets_list', {})).sets);
      const referenced = new Set(sets.flatMap((x) => x.recordings.filter((e) => e.n_reference_events > 0).map((e) => `${x.scope}|${e.recording_id}`)));
      const annotated = mine.filter((r) => r.done > 0 || referenced.has(key(r))).map(key).sort();
      const card = section.locator('.card', { hasText: 'Add a recording with its reference' });
      await card.waitFor();
      const list = async () => (await card.locator('select').first().locator('option').evaluateAll((os) => os.map((o) => o.value))).filter(Boolean).sort();
      assert.ok(annotated.length > 0 && annotated.length < mine.length, 'the sandbox has annotated and unannotated recordings');
      assert.deepEqual(await list(), annotated);
      assert.match(await card.textContent(), /Only recordings with annotations \(someone's saved work, or a reference already\); 3 recordings with none are left out/);
      // an annotation file brings its own: every registered recording
      await card.locator('label', { hasText: 'An annotation file' }).click();
      assert.deepEqual(await list(), mine.map(key).sort());
      await t.screenshot(page, 'expert_training_sets');

      // The users list gives an expert IDs only, and the rest of the admin area answers no.
      const users = await page.evaluate(async () => (await globalThis.ElectroTag.backend.admin('users_list', {})).users);
      assert.ok(users.every((u) => Object.keys(u).sort().join() === 'annotator_id,roles'));
      const refused = await page.evaluate(async () => {
        try { await globalThis.ElectroTag.backend.admin('overview', {}); return null; } catch (exc) { return exc.status; }
      });
      assert.equal(refused, 403);
    },
  },
];
