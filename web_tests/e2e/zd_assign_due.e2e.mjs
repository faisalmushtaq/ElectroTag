// A due date chosen in Assignments (docs/admin_area.md, "Assignments"): the recordings chosen become a hand-out
// of their own with that date, listed under Hand-outs, and the annotator's home page shows them under "Recordings
// due" with the date. In the demonstration.
import { signIn, waitForRoute } from './helpers.mjs';

export const tests = [
  {
    name: 'demonstration: recordings assigned with a due date are a hand-out the annotator sees with its date',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'ADMIN');
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-assignments'));
      await waitForRoute(page, 'admin-assignments');
      const section = '.admin-section[data-section="assignments"]';
      await page.waitForSelector(`${section} [data-log="assign-due"]`);
      await page.locator(`${section} input[data-name="annotators"][value="A01"]`).check();
      const first = page.locator(`${section} input[data-name="recordings"]`).first();
      await first.check();
      // a day in the past is refused in words
      await page.fill(`${section} [data-log="assign-due"]`, '2020-01-01');
      await page.click(`${section} [data-log="assign"]`);
      await page.waitForFunction((s) => /The due date has passed/.test(document.querySelector(s).innerText), section);
      await page.fill(`${section} [data-log="assign-due"]`, '2099-11-20');
      await page.click(`${section} [data-log="assign"]`);
      await page.waitForFunction((s) => /Assigned, due 20 Nov 2099/.test(document.querySelector(s).innerText), section, { timeout: 20000 });
      assert.match(await page.innerText(section), /listed under Hand-outs as Recordings due 20 November/);
      await t.screenshot(page, 'assign_with_due_date');
      // the due date field is for the study's own work only
      await page.locator(`${section} select`).first().selectOption('practice');
      assert.equal(await page.isVisible(`${section} [data-log="assign-due"]`), false);
      const handouts = await page.evaluate(() => globalThis.ElectroTag.backend.admin('handouts_list', {}));
      assert.equal(handouts.handouts.length, 1);
      assert.equal(handouts.handouts[0].due_at, '2099-11-20');
      assert.equal(handouts.handouts[0].target.kind, 'recordings');
      // A01 sees the recording with its due date
      await page.evaluate(() => globalThis.ElectroTag.backend.logout());
      await page.reload();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.waitForFunction(() => /Recordings due 20 November/.test(document.body.innerText), null, { timeout: 20000 });
    },
  },
];
