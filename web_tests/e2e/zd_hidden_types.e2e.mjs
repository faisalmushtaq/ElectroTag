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

      await blink.uncheck();
      assert.equal(await page.inputValue('select[aria-label="Key 1"]'), '', 'taken off its key at once');
      assert.match(await settings.locator('.keys-cleared').textContent(), /key 1 \(Eye-blink-artifact\)/);
      assert.equal(await page.locator('select[aria-label="Key 2"] option[value="Eye-blink-artifact"]').isDisabled(), true);
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
