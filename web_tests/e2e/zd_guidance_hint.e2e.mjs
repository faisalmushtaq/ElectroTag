// Managing a guided recording of a reference set (docs/admin_area.md, "Recordings and references"): the line
// under How much help the guided recording gives says what the level chosen does, and follows the choice;
// Correct the marks is offered only for a recording whose exercise (the copy with deliberate mistakes) is made.
import { signIn, waitForRoute } from './helpers.mjs';
import { GUIDANCE, GUIDANCE_HINTS } from '../../electrotag/web/static/js/admin/model.js';

export const tests = [
  {
    name: 'how much help a guided recording gives: each level described as it is chosen, Correct the marks only with an exercise',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');
      await page.evaluate(() => { location.hash = '#admin-training'; });
      await waitForRoute(page, 'admin-training');
      const section = page.locator('.admin-section[data-section="training"]');
      const rows = section.locator('tbody tr', { hasText: 'Guided' });
      await rows.first().waitFor();
      // the sandbox's ready-made exercise is for one of the two guided recordings
      const exercises = await page.evaluate(async () => {
        const got = await globalThis.ElectroTag.backend.expert('planted_list', {});
        return Object.fromEntries(got.sets.flatMap((s) => s.recordings.map((r) => [r.recording_id, Boolean(r.planted && !r.planted.stale)])));
      });
      assert.deepEqual(Object.values(exercises).sort(), [false, true]);
      const field = section.locator('.admin-field', { hasText: 'How much help the guided recording gives' });
      const hint = field.locator('[data-log="guidance-hint"]');
      const choice = field.locator('select');
      const offered = () => choice.locator('option').evaluateAll((os) => os.map((o) => o.value));
      for (let i = 0; i < await rows.count(); i++) {
        const rid = await rows.nth(i).locator('td').first().textContent();
        const id = Object.keys(exercises).find((k) => rid.includes(k.split('/').pop()));
        await rows.nth(i).locator('button', { hasText: 'Manage' }).click();
        await field.waitFor();
        await page.waitForTimeout(400); // the study is asked whether the recording has its exercise
        const levels = await offered();
        if (exercises[id]) {
          assert.deepEqual(levels, Object.keys(GUIDANCE), `${id} has its exercise: every level`);
          assert.equal(await field.locator('[data-log="guidance-correct-note"]').textContent(), '');
          // each level's own description, as it is chosen
          const seen = new Set();
          for (const level of levels) {
            await choice.selectOption(level);
            assert.equal(await hint.textContent(), GUIDANCE_HINTS[level], level);
            seen.add(await hint.textContent());
          }
          assert.equal(seen.size, levels.length, 'each level has a description of its own');
        } else {
          assert.deepEqual(levels, Object.keys(GUIDANCE).filter((k) => k !== 'correct'), `${id} has no exercise: no Correct the marks`);
          assert.match(await field.locator('[data-log="guidance-correct-note"]').textContent(), /offered once this recording has its exercise/);
          assert.equal(await hint.textContent(), GUIDANCE_HINTS[await choice.inputValue()]);
        }
        await section.locator('.card-head button', { hasText: 'Close' }).click();
      }
    },
  },
];
