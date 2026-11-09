// The Training section's forms (docs/admin_area.md, "Competency criteria", "Quiz" and "Snippets"): a criterion's
// threshold can be set at once, ticking it; a quiz item and a snippet are chosen from the artifacts the experts
// marked on the recording, which fill in their times (and type and channels) and show on the EEG.
import { signIn, waitForRoute } from './helpers.mjs';

async function trainingTab(page, title) {
  await page.evaluate(() => { location.hash = '#admin-training'; });
  await waitForRoute(page, 'admin-training');
  const section = page.locator('.admin-section[data-section="training"]');
  await section.locator('.set-item').first().waitFor();
  await section.locator('[role="tab"]', { hasText: title }).click();
  return section;
}

export const tests = [
  {
    name: 'Training: criteria set without ticking first, quiz items and snippets chosen from the experts\' marks',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');

      // Competency criteria: every threshold can be given at once, and giving one ticks its criterion
      let section = await trainingTab(page, 'Competency criteria');
      const first = section.locator('.criterion').first();
      await first.waitFor();
      const box = first.locator('input[type="checkbox"]');
      const threshold = first.locator('input[type="number"]');
      if (await box.isChecked()) await box.uncheck();
      assert.equal(await threshold.isEnabled(), true, 'a threshold can be set before its criterion is ticked');
      await threshold.fill('0.6');
      assert.equal(await box.isChecked(), true, 'setting it ticks the criterion');

      // Quiz: the recording's marked artifacts, one chosen, its times and type filled in
      section = await trainingTab(page, 'Quiz');
      const quiz = section.locator('.card', { hasText: 'Add a quiz item' });
      const picks = quiz.locator('[data-log="artifact-pick"]');
      await picks.first().waitFor();
      const notes = await page.evaluate(async () => {
        const sets = (await globalThis.ElectroTag.backend.admin('sets_list', {})).sets;
        const set = sets[0];
        const card = [...document.querySelectorAll('.card')].find((c) => /Add a quiz item/.test(c.textContent));
        const rid = card.querySelector('select').value;
        return (await globalThis.ElectroTag.backend.admin('set_guided_notes', { set_id: set.set_id, recording_id: rid })).notes;
      });
      assert.equal(await picks.count(), Math.min(notes.length, 40));
      // only the set's guided recordings whose reference marks artifacts are offered
      const offered = await quiz.locator('.admin-field', { has: page.locator('label:text-is("Recording")') }).locator('option').evaluateAll((os) => os.map((o) => o.value));
      const expected = await page.evaluate(async () => (await globalThis.ElectroTag.backend.admin('sets_list', {})).sets[0].recordings
        .filter((e) => e.use === 'guided' && e.n_reference_events > 0).map((e) => e.recording_id));
      assert.deepEqual(offered.sort(), expected.sort());
      const sorted = [...notes].sort((a, b) => a.onset_s - b.onset_s);
      await picks.nth(1).click();
      assert.equal(await picks.nth(1).getAttribute('aria-pressed'), 'true');
      const field = (card, label) => card.locator('.admin-field', { has: page.locator(`label:text-is("${label}")`) }).locator('input, select').first();
      assert.equal(Number(await field(quiz, 'Start (s)').inputValue()), Math.round(sorted[1].onset_s * 1000) / 1000);
      assert.equal(Number(await field(quiz, 'End (s)').inputValue()), Math.round(sorted[1].offset_s * 1000) / 1000);
      assert.equal(await field(quiz, 'Correct answer').inputValue(), sorted[1].label);
      // narrowed to one type
      const filter = quiz.locator('[data-log="artifact-filter"]');
      if (await filter.isVisible()) {
        await filter.selectOption(sorted[0].label);
        assert.equal(await picks.count(), sorted.filter((a) => a.label === sorted[0].label).length);
      }
      // and shown on the EEG once the recording is open here
      await quiz.locator('[data-log="snippet-preview-example"]').click();
      await quiz.locator('.admin-snippet-eeg:not([hidden]) canvas').first().waitFor({ timeout: 30000 });
      assert.match(await quiz.locator('.snippet-preview-status').textContent(), /As trainees see it/);
      await t.screenshot(page, 'training_quiz_picker');

      // Snippets: type, times and channels from the chosen artifact
      section = await trainingTab(page, 'Snippets');
      const snip = section.locator('.card', { hasText: 'Add a snippet' });
      const spicks = snip.locator('[data-log="artifact-pick"]');
      await spicks.first().waitFor();
      await spicks.first().click();
      const a = await page.evaluate(() => document.querySelector('.card [data-log="artifact-pick"][aria-pressed="true"]').textContent);
      const [label, , chans] = a.split(' · ');
      assert.equal(await field(snip, 'Type').inputValue(), label);
      assert.equal(await field(snip, 'Channels').inputValue(), chans === 'whole montage' ? '' : chans);
      assert.ok(Number(await field(snip, 'Ends at (s)').inputValue()) > Number(await field(snip, 'Starts at (s)').inputValue()));
    },
  },
];
