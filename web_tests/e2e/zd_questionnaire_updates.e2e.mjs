// Questions added to the sign-up questionnaire after people have answered it (docs/admin_area.md, "Study settings";
// docs/using.md, "Before your first recording"): the administrator adds a short-answer question with tick boxes in
// Study settings; an annotator who had answered is asked it at their next sign-in, before anything else, with the
// question marked New or changed and no way past it; a tick box greys out the text and answers the question.
import { signIn, waitForRoute } from './helpers.mjs';

export const tests = [
  {
    name: 'a question added in Study settings is asked at the next sign-in, and None greys out the text',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 900 });

      // The administrator adds a required short answer with two tick boxes.
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag.adminArea);
      await page.evaluate(() => globalThis.ElectroTag.showAdmin('admin-settings'));
      await page.click('[data-log="questionnaire-add"]');
      const row = page.locator('details.q-edit[open]').last();
      await row.locator('.admin-field').nth(0).locator('input').fill('Which montage do you read EEG in?');
      await row.locator('.admin-field', { hasText: 'Answers' }).locator('select').selectOption('text');
      const boxes = row.locator('.admin-field', { hasText: 'Tick boxes instead of the text' });
      await boxes.waitFor();
      assert.equal(await row.locator('.admin-field', { hasText: 'Option that asks for their own words' }).isHidden(), true);
      await boxes.locator('textarea').fill('None\nNot applicable');
      await page.click('[data-log="settings-save"]');
      await page.waitForFunction(() => /The settings are saved/.test(document.querySelector('.admin-section[data-section="settings"] .sticky-save .admin-msg')?.textContent || ''));
      const saved = await page.evaluate(() => globalThis.ElectroTag.backend.admin('settings_get'));
      const added = saved.settings.questionnaire.questions.find((q) => q.text === 'Which montage do you read EEG in?');
      assert.deepEqual([added.type, added.options, added.required], ['text', ['None', 'Not applicable'], true]);
      await page.click('[data-log="leave-admin"]');
      await waitForRoute(page, 'home');
      await page.click('[data-log="sign-out"]');

      // A01 answered before: at the next sign-in, the new question comes first, marked, with no way past it.
      await signIn(page, 'A01', 'demo', { questionnaire: 'stay' });
      await waitForRoute(page, 'questionnaire', 30000);
      assert.equal(await page.textContent('.q-page h1'), 'A new question');
      assert.match(await page.textContent('.q-page .subtitle'), /added or changed a question, marked New or changed below/);
      assert.equal(await page.locator('.q-page [data-log="questionnaire-back"]').count(), 0, 'no way past it');
      const q = page.locator(`fieldset.q-question[data-question="${added.id}"]`);
      assert.equal(await q.locator('.q-new').textContent(), 'New or changed');
      assert.equal(await page.locator('fieldset.q-due').count(), 1, 'only the new question is marked');
      assert.equal(await page.isChecked('fieldset[data-question="datasets_analysed"] input[value="3–10"]'), true, 'the other answers are kept');
      // the tick boxes answer instead of the text: one at a time, and the text greyed out while one is ticked
      const text = q.locator('input.q-answer');
      await q.locator('label.q-instead', { hasText: 'None' }).click();
      assert.equal(await text.isDisabled(), true);
      await q.locator('label.q-instead', { hasText: 'Not applicable' }).click();
      assert.equal(await q.locator('input[data-answer="None"]').isChecked(), false);
      await q.locator('label.q-instead', { hasText: 'Not applicable' }).click();
      assert.equal(await text.isDisabled(), false, 'unticked, the text is open again');
      await q.locator('label.q-instead', { hasText: 'None' }).click();
      // the pre-processing question of the defaults works the same way
      const pre = page.locator('fieldset.q-question[data-question="preprocessing"]');
      assert.deepEqual(await pre.locator('label.q-instead').allTextContents(), ['None', 'Not applicable']);
      await page.click('[data-log="questionnaire-save"]');
      await page.waitForFunction(() => globalThis.ElectroTag.route !== 'questionnaire', null, { timeout: 30000 });
      const me = await page.evaluate(() => globalThis.ElectroTag.backend.me());
      assert.deepEqual([me.questionnaire.missing, me.questionnaire.to_answer], [0, []]);
      const view = await page.evaluate(() => globalThis.ElectroTag.backend.questionnaire());
      assert.equal(view.answers[added.id], 'None');
    },
  },
];
