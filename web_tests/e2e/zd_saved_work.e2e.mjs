// One person's saved work in the admin area (docs/admin_area.md, "Results"; js/admin/saved_work.js): in
// Results, the person's Work offers Download (every version, one zip) and Withdraw, which asks what happens to
// the recording; the withdrawn work is listed with Restore, and the same buttons are on the person's page under
// Annotators. In the demonstration.
import { signIn, waitForRoute } from './helpers.mjs';

export const tests = [
  {
    name: 'demonstration: saved work is downloaded, withdrawn and restored from a person\'s Work',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      // A01 saves their first recording, behind the scenes
      const rid = await page.evaluate(async () => {
        const b = globalThis.ElectroTag.backend;
        const item = (await b.assignments()).items[0];
        const sha = (await b.exampleRecording(item.recording_id).fingerprint()).hex;
        await b.submit({ recording_id: item.recording_id, mode: 'standard', context_id: '', annotations: [], session: { elapsed_s: 5 }, sha256: sha });
        await b.logout();
        return item.recording_id;
      });
      await page.reload();
      await signIn(page, 'ADMIN');
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-results'));
      await waitForRoute(page, 'admin-results');
      const section = '.admin-section[data-section="results"]';
      const person = page.locator(`${section} tr`, { hasText: 'A01' }).first();
      await person.locator('button', { hasText: 'Work' }).click();
      const row = page.locator(`${section} tr:has(button[data-log="saved-work-withdraw"])`);
      await row.first().waitFor();
      assert.equal(await row.count(), 1);
      // Download: one zip of every version
      const [download] = await Promise.all([page.waitForEvent('download'), row.locator('[data-log="saved-work-download"]').click()]);
      assert.match(download.suggestedFilename(), /_A01_saved\.zip$/);
      // Withdraw: the question, then the recording given back to annotate again
      await row.locator('[data-log="saved-work-withdraw"]').click();
      await page.waitForSelector('.dialog.withdraw-question');
      assert.match(await page.innerText('.dialog'), /leaves the study's results/);
      await t.screenshot(page, 'saved_work_withdraw_question');
      await page.click('.dialog-buttons button:has-text("Give it back to annotate again")');
      await page.waitForSelector(`${section} [data-part="withdrawn"] button[data-log="saved-work-restore"]`);
      assert.match(await page.innerText(section), /is withdrawn, and the recording is given back to annotate again/);
      assert.equal(await page.locator(`${section} button[data-log="saved-work-withdraw"]`).count(), 0);
      const status = await page.evaluate(async (r) => (await globalThis.ElectroTag.backend.admin('assignments_list', { annotator_id: 'A01' }))
        .items.find((i) => i.recording_id === r).status, rid);
      assert.equal(status, 'todo');
      await t.screenshot(page, 'saved_work_withdrawn');
      // Restore: back as it was
      await page.click(`${section} [data-log="saved-work-restore"]`);
      await page.waitForSelector(`${section} button[data-log="saved-work-withdraw"]`);
      assert.match(await page.innerText(section), /is back in the results/);
      assert.equal(await page.locator(`${section} [data-part="withdrawn"] button`).count(), 0);
      // the same buttons on the person's page under Annotators
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-annotators', { annotator: 'A01' }));
      await page.waitForSelector('.admin-section[data-section="annotators"] [data-log="saved-work-withdraw"]');
      const audit = await page.evaluate(() => globalThis.ElectroTag.backend.admin('audit', { limit: 2 }));
      assert.deepEqual(audit.entries.map((e) => e.op), ['saved_work_restore', 'saved_work_withdraw']);
    },
  },
];
