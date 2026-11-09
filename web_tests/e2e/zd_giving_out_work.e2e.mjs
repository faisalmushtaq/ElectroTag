// Giving out work (docs/admin_area.md, "Giving out work"): one entry in the menu, with Everything given out,
// Assignments, Hand-outs and Tasks as its tabs; the list of everything given out shows every recording each
// person has and how it reached them, including those assigned one by one, which the lists of hand-outs and
// tasks leave out. In the demonstration.
import { signIn, waitForRoute } from './helpers.mjs';

export const tests = [
  {
    name: 'demonstration: Giving out work lists everything given out, with how, and its tabs lead to the three ways',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');
      await page.evaluate(() => { location.hash = '#admin'; });
      await waitForRoute(page, 'admin');
      // one entry in the menu for the three
      const people = await page.$$eval('.admin-group[data-group="people"] a.admin-nav-link', (els) => els.map((e) => e.textContent.trim()));
      assert.deepEqual(people, ['Annotators', 'Groups', 'Giving out work', 'Training', 'Questionnaire']);

      // assigned one by one, and with a due date (a hand-out of its own)
      await page.locator('.admin-nav a', { hasText: 'Giving out work' }).click();
      await waitForRoute(page, 'admin-work');
      await page.locator('.work-tabs a', { hasText: 'Assignments' }).click();
      await waitForRoute(page, 'admin-assignments');
      assert.equal(await page.getAttribute('.admin-nav a[data-section="work"]', 'aria-current'), 'page', 'the menu shows the page of the tab');
      assert.equal(await page.getAttribute('.work-tabs a[data-tab="assignments"]', 'aria-current'), 'page');
      const section = '.admin-section[data-section="assignments"]';
      await page.waitForSelector(`${section} [data-log="assign-due"]`);
      // A01 has the example recordings, assigned one by one; one of them is given again with a due date (a hand-out of its own)
      await page.locator(`${section} input[data-name="annotators"][value="A01"]`).check();
      await page.locator(`${section} input[data-name="recordings"]`).nth(1).check();
      await page.fill(`${section} [data-log="assign-due"]`, '2099-11-20');
      await page.click(`${section} [data-log="assign"]`);
      await page.waitForFunction((s) => /Assigned, due 20 Nov 2099/.test(document.querySelector(s).innerText), section, { timeout: 20000 });
      const n = (await page.evaluate(() => globalThis.ElectroTag.backend.admin('assignments_list', { annotator_id: 'A01' }))).items.length;
      assert.ok(n >= 2, `A01 has ${n}`);

      // Everything given out: both, said how; the filters find each way
      await page.locator('.work-tabs a', { hasText: 'Everything given out' }).click();
      await waitForRoute(page, 'admin-work');
      const work = '.admin-section[data-section="work"]';
      await page.locator(`${work} select[aria-label="Annotator"]`).selectOption('A01');
      await page.waitForFunction(({ s, n }) => document.querySelectorAll(`${s} table.admin-list tbody tr`).length === n, { s: work, n });
      const rows = await page.$$eval(`${work} table.admin-list tbody tr`, (trs) => trs.map((tr) => tr.innerText));
      assert.ok(rows.some((r) => /Assigned by itself/.test(r)), rows.join('\n'));
      assert.ok(rows.some((r) => /Hand-out\s*Recordings due 20 November \(given in Assignments\)/.test(r)), rows.join('\n'));
      assert.match(await page.innerText(`${work} p.caption[role="status"]`), new RegExp(`^${n} given to 1 person, \\d+ done: 1 by a hand-out, ${n - 1} assigned by (itself|themselves)\\.`));
      await page.locator(`${work} select[aria-label="Given through"]`).selectOption('handout');
      await page.waitForFunction((s) => document.querySelectorAll(`${s} table.admin-list tbody tr`).length === 1, work);
      await page.locator(`${work} select[aria-label="Annotator"]`).selectOption('');
      await t.screenshot(page, 'giving_out_work');
      // the hand-out opens from its row
      await page.locator(`${work} [data-log="work-open-handout"]`).click();
      await waitForRoute(page, 'admin-handouts');
      assert.equal(await page.getAttribute('.work-tabs a[data-tab="handouts"]', 'aria-current'), 'page');
      // each tab's Help is its part of the guide
      assert.equal(await page.getAttribute('.admin-section[data-section="handouts"] a[data-help]', 'data-help'), 'hand-outs');
      await page.locator('.work-tabs a', { hasText: 'Tasks' }).click();
      await waitForRoute(page, 'admin-tasks');
      assert.equal(await page.innerText('.admin-section[data-section="tasks"] h1'), 'Giving out work');
    },
  },
];
