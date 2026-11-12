// Before the study starts (docs/admin_area.md, "Before the study starts"): the Overview lists the settings a study
// confirms before its first study recording is saved; the agreement settings are saved as the study's on the
// Analyses page (and the form starts from them afterwards), each group is confirmed on its own, the list folds
// into one line once all are confirmed, and a change in Study settings asks for that group to be confirmed again.
import { signIn } from './helpers.mjs';

const item = (page, name) => page.locator(`.prereg-item[data-item="${name}"]`);
const stateOf = (page, name) => item(page, name).getAttribute('data-state');

async function overview(page) {
  await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin'));
  await page.locator('.overview-prereg .prereg-list').waitFor();
}

export const tests = [
  {
    name: 'before the study starts: the settings saved, confirmed one by one, folded away when done and asked for again when changed',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag.adminArea);
      await overview(page);
      const card = page.locator('.prereg-card');
      assert.match(await card.locator('h2').textContent(), /^Before the study starts$/);
      assert.deepEqual(await Promise.all(['agreement', 'working_time', 'repeats'].map((n) => stateOf(page, n))), ['not_confirmed', 'not_confirmed', 'not_confirmed']);
      assert.equal(await page.locator('[data-log="prereg-confirm-agreement"]').isDisabled(), true, 'the agreement settings are saved first');
      assert.match(await item(page, 'agreement').textContent(), /Not saved yet/);
      assert.match(await item(page, 'working_time').textContent(), /Active time \(active_s\)/);

      await page.click('[data-log="prereg-confirm-working_time"]');
      await page.waitForFunction(() => document.querySelector('.prereg-item[data-item="working_time"]')?.dataset.state === 'confirmed');
      assert.match(await item(page, 'working_time').textContent(), /Confirmed by ADMIN \(.*\), before the study started\./);

      // The agreement settings, chosen on the Analyses page and saved as the study's.
      await item(page, 'agreement').locator('button[data-to="analyses"]').click();
      const analyses = page.locator('.admin-section[data-section="analyses"]');
      await analyses.locator('summary', { hasText: 'Settings of the analysis' }).click();
      assert.match(await analyses.locator('.prereg-note').textContent(), /analysis's defaults/);
      await analyses.locator('.admin-field', { hasText: 'Time bins (s)' }).locator('input').fill('0.5 1');
      await analyses.locator('[data-log="agreement-preregister"]').click();
      await page.waitForFunction(() => /Saved as the study's agreement settings/.test(document.querySelector('.admin-section[data-section="analyses"]').textContent));
      assert.match(await analyses.locator('.prereg-note').textContent(), /saved settings, not confirmed yet/);

      await overview(page);
      assert.match(await item(page, 'agreement').textContent(), /Time bins of 0\.5, 1 s/);
      await page.click('[data-log="prereg-confirm-agreement"]');
      await page.waitForFunction(() => document.querySelector('.prereg-item[data-item="agreement"]')?.dataset.state === 'confirmed');
      await page.click('[data-log="prereg-confirm-repeats"]');
      // all confirmed: one folded line
      await page.locator('details.prereg-done').waitFor();
      assert.equal(await page.locator('.prereg-card').count(), 0);
      assert.match(await page.locator('details.prereg-done summary').textContent(), /all confirmed/);

      // The form starts from the study's settings now.
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-analyses'));
      await analyses.locator('.prereg-note').waitFor({ state: 'attached' });
      await page.waitForFunction(() => /pre-registered settings, confirmed by ADMIN/.test(document.querySelector('.admin-section[data-section="analyses"] .prereg-note').textContent));
      assert.equal(await analyses.locator('.admin-field', { hasText: 'Time bins (s)' }).locator('input').inputValue(), '0.5 1');

      // Wall-clock time chosen in Study settings: working time is to confirm again.
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-settings'));
      const settings = page.locator('.admin-section[data-section="settings"]');
      await settings.locator('select[name="working_time"]').selectOption('wall_s');
      await settings.locator('[data-log="settings-save"]').click();
      await page.waitForFunction(() => !document.querySelector('.admin-section[data-section="settings"] .unsaved-note:not([hidden])'));
      await overview(page);
      assert.equal(await stateOf(page, 'working_time'), 'changed');
      assert.match(await item(page, 'working_time').textContent(), /Changed since confirmed.*Wall-clock time \(wall_s\)/s);
      assert.equal(await page.locator('[data-log="prereg-confirm-working_time"]').textContent(), 'Confirm again');
    },
  },
];
