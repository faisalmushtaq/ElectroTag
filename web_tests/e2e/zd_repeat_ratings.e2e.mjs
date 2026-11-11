// Repeat ratings (docs/admin_area.md, "Repeat ratings"): an administrator switches them on and adds rules in
// the admin area (in order, for all recordings or for chosen datasets and recordings, with how many repeats
// and the days between); a recording an annotator saved comes back once its days have passed, as a new
// recording with nothing of the earlier rating shown, and its save is marked as the repeat; it does not come
// back before its days, nor after its last repeat.
import { clickDialogButton, openExample, pressSave, signIn, waitForRoute } from './helpers.mjs';

async function switchTo(page, id) {
  await page.evaluate(async () => { await globalThis.ElectroTag.signOut(); });
  const leave = page.locator('.dialog-buttons button', { hasText: /Keep|Sign out/ });
  if (await leave.count()) await leave.first().click();
  await signIn(page, id);
}

const DAY = 864e5;
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY).toISOString().replace('Z', '+00:00');

export const tests = [
  {
    name: 'repeat ratings: set in the admin area, offered again after their days as a new recording, saved as the repeat',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      // A01 saves the first example recording (the first rating)...
      await openExample(page, 0);
      await pressSave(page);
      await clickDialogButton(page, 'Save with no artifacts');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 20000 });
      await clickDialogButton(page, 'Back to my recordings');
      await waitForRoute(page, 'home');
      const first = await page.evaluate(() => globalThis.ElectroTag.backend.state.submissions.at(-1));
      assert.equal(first.retest, undefined);

      // The administrator switches repeat ratings on: one rule for the first recording (2 repeats, 3 days apart),
      // then a rule for all the others (1 repeat after 30 days).
      await switchTo(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag.adminArea);
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-repeats'));
      const section = page.locator('.admin-section[data-section="repeats"]');
      await section.locator('[data-log="repeats-save"]').waitFor();
      assert.equal(await section.locator('[data-log="repeats-enabled"]').isChecked(), false, 'off until switched on');
      await section.locator('[data-log="repeats-enabled"]').check();
      await section.locator('[data-log="repeat-rule-add"]').click();
      await section.locator('[data-log="repeat-rule-add"]').click();
      const rule1 = section.locator('fieldset.repeat-rule').nth(0);
      const rule2 = section.locator('fieldset.repeat-rule').nth(1);
      assert.match(await rule1.locator('.repeat-words').textContent(), /Every recording not covered by a rule above: rated once more, 14 days after the first rating/);
      await rule1.locator('input[type="text"]').first().fill('First example');
      await rule1.locator('input[value="some"]').check();
      await rule1.locator('.repeat-some').waitFor({ state: 'visible' });
      await rule1.locator(`input[type="checkbox"][value="${first.recording_id}"]`).check();
      await rule1.locator('input[type="number"]').nth(0).fill('2');
      await rule1.locator('input[type="number"]').nth(1).fill('3');
      assert.equal(await section.locator('.sticky-save').count(), 1);
      assert.match(await rule1.locator('.repeat-words').textContent(), /^1 recording: rated 2 more times, 3 days apart\.$/);
      await rule2.locator('input[value="all"]').check();
      await rule2.locator('input[type="number"]').nth(1).fill('30');
      // A rule for some recordings with none chosen is refused, in words.
      await rule2.locator('input[value="some"]').check();
      await section.locator('[data-log="repeats-save"]').click();
      await section.locator('.sticky-save .error-banner, .sticky-save [role="alert"]').first().waitFor();
      assert.match(await section.locator('.sticky-save').textContent(), /Rule 2 applies to some recordings: choose at least one dataset or recording/);
      await rule2.locator('input[value="all"]').check();
      // Moving the rule for all recordings above would hide the other: put back in order before saving.
      await t.screenshot(page, 'repeat_rules');
      await section.locator('[data-log="repeats-save"]').click();
      await page.waitForFunction(() => /Saved\. A recording comes back/.test(document.querySelector('.admin-section[data-section="repeats"] .sticky-save').textContent));
      const kept = await page.evaluate(() => globalThis.ElectroTag.backend._admin.s.settings.repeats);
      assert.equal(kept.enabled, true);
      assert.deepEqual(kept.rules.map((r) => [r.name, r.recordings, r.recording_ids.length, r.repeats, r.interval_days]),
        [['First example', 'some', 1, 2, 3], ['', 'all', 0, 1, 30]]);
      // The audit log names the change.
      const audit = await page.evaluate(() => globalThis.ElectroTag.backend._admin.s.audit.at(-1));
      assert.equal(audit.op, 'settings_update');
      assert.match(audit.summary, /enabled \(repeats\) from off to on/);
      assert.match(audit.summary, /rules .* \(repeats\) added/);

      // Not yet due: the recording is still done for A01.
      await switchTo(page, 'A01');
      await waitForRoute(page, 'home');
      const statusOf = () => page.evaluate(async (rid) => (await globalThis.ElectroTag.backend.assignments()).items.find((i) => i.recording_id === rid), first.recording_id);
      assert.equal((await statusOf()).status, 'done');

      // Four days later (the first save moved back), it comes back as a new recording, with no history shown.
      await page.evaluate(([rid, at]) => {
        const b = globalThis.ElectroTag.backend;
        for (const s of b.state.submissions) if (s.recording_id === rid) s.saved_at = at;
        b._save();
      }, [first.recording_id, isoDaysAgo(4)]);
      let item = await statusOf();
      assert.equal(item.status, 'todo');
      assert.equal(item.saved, null, 'nothing of the earlier rating');
      assert.equal(item.repeat, false, 'not labelled as a repeat');
      assert.equal(item.completed_at, null);
      // It opens with no annotations, and its save is the first repeat.
      await page.evaluate(() => globalThis.ElectroTag.showHome && globalThis.ElectroTag.showHome());
      await openExample(page, 0);
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.store.annotations().length), 0, 'the earlier marks are not shown');
      await pressSave(page);
      await clickDialogButton(page, 'Save with no artifacts');
      await page.waitForSelector('.dialog .dialog-title', { timeout: 20000 });
      await clickDialogButton(page, 'Back to my recordings');
      const second = await page.evaluate(() => globalThis.ElectroTag.backend.state.submissions.at(-1));
      assert.equal(second.retest, 1);
      assert.equal(second.attempt, 2);
      const doc = await page.evaluate(() => globalThis.ElectroTag.backend.resultsDocument().annotation_documents.at(-1));
      assert.deepEqual(doc.session.context.retest, { number: 1 });
      // Done again until its days have passed since the repeat; then the second repeat, and after it no more.
      assert.equal((await statusOf()).status, 'done');
      await page.evaluate(([rid, at]) => {
        const b = globalThis.ElectroTag.backend;
        for (const s of b.state.submissions) if (s.recording_id === rid && s.retest === 1) s.saved_at = at;
        b._save();
      }, [first.recording_id, isoDaysAgo(3.5)]);
      item = await statusOf();
      assert.equal(item.status, 'todo', 'the second repeat');
      await page.evaluate(([rid]) => {
        const b = globalThis.ElectroTag.backend;
        const s = b.state.submissions.find((x) => x.recording_id === rid && x.retest === 1);
        b.state.submissions.push({ ...s, attempt: 3, retest: 2, saved_at: new Date(Date.now() - 400 * 864e5).toISOString().replace('Z', '+00:00') });
        b._save();
      }, [first.recording_id]);
      assert.equal((await statusOf()).status, 'done', 'two repeats, as the rule asks: no more');
    },
  },
];
