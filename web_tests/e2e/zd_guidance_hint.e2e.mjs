// Managing a guided recording of a reference set (docs/admin_area.md, "Recordings and references"): the line
// under How much help the guided recording gives says what the level chosen does, and follows the choice.
import { signIn, waitForRoute } from './helpers.mjs';
import { GUIDANCE, GUIDANCE_HINTS } from '../../electrotag/web/static/js/admin/model.js';

export const tests = [
  {
    name: 'the description of how much help a guided recording gives follows the level chosen',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');
      await page.evaluate(() => { location.hash = '#admin-training'; });
      await waitForRoute(page, 'admin-training');
      const section = page.locator('.admin-section[data-section="training"]');
      const guided = section.locator('tbody tr', { hasText: 'Guided' }).first();
      await guided.waitFor();
      await guided.locator('button', { hasText: 'Manage' }).click();
      const field = section.locator('.admin-field', { hasText: 'How much help the guided recording gives' });
      await field.waitFor();
      const hint = field.locator('[data-log="guidance-hint"]');
      const choice = field.locator('select');
      assert.equal(await hint.textContent(), GUIDANCE_HINTS[await choice.inputValue()]);
      const seen = new Set();
      for (const level of Object.keys(GUIDANCE)) {
        await choice.selectOption(level);
        const text = await hint.textContent();
        assert.equal(text, GUIDANCE_HINTS[level], level);
        seen.add(text);
      }
      assert.equal(seen.size, Object.keys(GUIDANCE).length, 'each level has a description of its own');
    },
  },
];
