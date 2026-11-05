// The warnings found when recordings were added, under Problems in the admin area (docs/admin_area.md,
// "Problems"): listed with the recording and what was found, dismissed from the list, shown again with
// Show the dismissed ones too, and listed again. In the demonstration.
import { signIn, waitForRoute } from './helpers.mjs';

const CARD = '.admin-section[data-section="problems"] [data-part="import-warnings"]';

export const tests = [
  {
    name: 'demonstration: the warnings found when a recording was added are under Problems, and can be dismissed and listed again',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900, url: `${t.base}#admin` });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      // one of the sandbox's recordings, as if the checks had noticed something when it was added
      const rid = await page.evaluate(() => {
        const r = globalThis.ElectroTag.backend._admin.s.recordings.find((x) => x.scope === 'study');
        r.warnings = ['Amplitude: Fp1 reaches 4 mV, far more than EEG usually does'];
        return r.recording_id;
      });
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-problems'));
      await waitForRoute(page, 'admin-problems');
      await page.waitForSelector(`${CARD} tbody tr`);
      const row = page.locator(`${CARD} tbody tr`);
      assert.equal(await row.count(), 1);
      assert.match(await row.innerText(), /Fp1 reaches 4 mV/);
      assert.match(await row.innerText(), /The study/);
      await t.screenshot(page, 'problems_import_warnings');
      // dismissed: gone from the list, kept behind Show the dismissed ones too
      await page.click(`${CARD} [data-log="warnings-dismiss"]`);
      await page.waitForFunction((c) => /is dismissed from the list/.test(document.querySelector(c).textContent), CARD);
      assert.equal(await page.locator(`${CARD} tbody tr`, { hasText: 'Fp1' }).count(), 0);
      await page.locator(`${CARD} label.check`).click();
      await page.waitForSelector(`${CARD} tbody tr:has-text("Dismissed by ADMIN")`);
      // listed again
      await page.click(`${CARD} [data-log="warnings-undismiss"]`);
      await page.waitForFunction((c) => /is listed again/.test(document.querySelector(c).textContent), CARD);
      assert.equal(await page.locator(`${CARD} tbody tr`, { hasText: 'Dismissed by' }).count(), 0);
      const audit = await page.evaluate(() => globalThis.ElectroTag.backend.admin('audit', { limit: 5 }));
      assert.ok(audit.entries.some((e) => e.op === 'recording_update' && e.summary.includes('dismissed the warnings') && e.summary.startsWith(rid)));
    },
  },
];
