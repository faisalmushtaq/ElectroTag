// Artifact types a study does not use (Study settings, Annotation; docs/admin_area.md, "Study settings"): unticked,
// a type leaves its number key at once and, once saved, every list an annotator chooses a type from.
import { signIn, waitForRoute, openExample, state } from './helpers.mjs';

export const tests = [
  {
    name: 'hidden artifact types: unticked in Study settings, gone from the keys and the type picker',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag.adminArea);
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-settings'));
      const settings = page.locator('.admin-section[data-section="settings"]');
      const blink = settings.locator('input[data-name="available-types"][value="Eye-blink-artifact"]');
      await blink.waitFor();
      assert.equal(await blink.isChecked(), true, 'every type is available at first');
      assert.equal(await settings.locator('input[data-name="available-types"][value="Data-artifact"]').count(), 0, 'the uncertain type is always available');
      assert.equal(await page.inputValue('select[aria-label="Key 1"]'), 'Eye-blink-artifact');

      assert.equal(await settings.locator('.types-in-training .banner').count(), 0, 'no warning while nothing is hidden');
      await blink.uncheck();
      assert.equal(await page.inputValue('select[aria-label="Key 1"]'), '', 'taken off its key at once');
      // the sandbox's training set has blinks among its reference marks and quiz answers
      assert.match(await settings.locator('.types-in-training .banner').textContent(),
        /A training set uses a type you are hiding.*Demonstration training set: Eye-blink-artifact \(\d+ reference marks and 1 quiz answer\)/);
      assert.match(await settings.locator('.keys-cleared').textContent(), /key 1 \(Eye-blink-artifact\)/);
      // (Playwright's isDisabled does not report an option's own disabled property, so it is read directly)
      assert.equal(await page.$eval('select[aria-label="Key 2"] option[value="Eye-blink-artifact"]', (o) => o.disabled), true, 'not offered on the other keys');
      await page.click('[data-log="settings-save"]');
      await page.waitForFunction(() => /The settings are saved/.test(document.querySelector('.admin-section[data-section="settings"] .sticky-save .admin-msg')?.textContent || ''));
      const saved = await page.evaluate(() => globalThis.ElectroTag.backend.admin('settings_get'));
      assert.deepEqual(saved.settings.annotation.hidden_labels, ['Eye-blink-artifact']);

      // An annotator: key 1 is the next type, and Find a type leaves the hidden one out.
      await page.click('[data-log="leave-admin"]');
      await waitForRoute(page, 'home');
      await page.click('[data-log="sign-out"]');
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const me = await page.evaluate(() => globalThis.ElectroTag.me);
      assert.deepEqual(me.study.annotation.hidden_labels, ['Eye-blink-artifact']);
      await openExample(page, 0);
      await page.keyboard.press('1');
      assert.equal((await state(page)).currentLabel, 'Horizontal-eye-movement-artifact');
      await page.keyboard.press('/');
      await page.locator('.picker-list').waitFor();
      assert.equal(await page.locator('.picker-list [data-label="Eye-blink-artifact"]').count(), 0);
      assert.ok(await page.locator('.picker-list [data-label="Horizontal-eye-movement-artifact"]').count() > 0);
      await page.keyboard.press('Escape');
    },
  },
];
