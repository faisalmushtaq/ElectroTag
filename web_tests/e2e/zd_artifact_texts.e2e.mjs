// Artifact type descriptions (docs/admin_area.md, "Artifact type descriptions"): an administrator puts a type's
// description and its guide entry in the study's own words, an annotator sees them on the type button and in the
// artifact reference guide, and Use the original takes them back. In the demonstration.
import { signIn, waitForRoute, waitForTraces } from './helpers.mjs';

const BLINK = 'Eye-blink-artifact';

export const tests = [
  {
    name: 'demonstration: a type\'s description and guide words in the study\'s own words, seen by annotators, and taken back',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'ADMIN');
      await page.waitForFunction(() => globalThis.ElectroTag && globalThis.ElectroTag.route !== 'signin');
      await page.evaluate(() => { location.hash = '#admin-training'; });
      await waitForRoute(page, 'admin-training');
      const box = page.locator('[data-part="artifact-texts"]');
      await box.locator('summary').click();
      await box.locator('select').first().waitFor();
      await box.locator('select').first().selectOption(BLINK);
      await box.locator('textarea[data-field="description"]').fill('A blink, in the words of our study.');
      await box.locator('textarea[data-field="shape"]').fill('A quick downward dip at Fp1 and Fp2.');
      await box.locator('[data-log="artifact-text-save"]').click();
      await box.locator('.chip', { hasText: 'The study\'s own words' }).first().waitFor();
      await t.screenshot(page, 'artifact_texts');
      const audit = await page.evaluate(() => globalThis.ElectroTag.backend.admin('audit', { limit: 3 }));
      assert.equal(audit.entries[0].op, 'artifact_text_set');
      // the administrator's own catalogue has the new words at once
      assert.equal(await page.evaluate((l) => globalThis.ElectroTag.catalogue.get(l).description, BLINK), 'A blink, in the words of our study.');
      await page.evaluate(() => globalThis.ElectroTag.backend.logout());
      await page.reload();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await page.locator('.example-card button').click();
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      assert.match(await page.getAttribute(`.chip-btn[data-label="${BLINK}"]`, 'title'), /A blink, in the words of our study\./);
      await page.click('.tab[data-tab="guide"]');
      const entry = page.locator(`.guide-type[data-label="${BLINK}"]`);
      await entry.waitFor();
      assert.match(await entry.textContent(), /A quick downward dip at Fp1 and Fp2\./);
      assert.match(await entry.textContent(), /A blink, in the words of our study\./);
      // back to the original
      await page.evaluate(async (l) => {
        const b = globalThis.ElectroTag.backend;
        await b.logout();
        await b.login('ADMIN', 'demo');
        await b.admin('artifact_text_set', { label: l, fields: { description: null, shape: null } });
      }, BLINK);
      const after = await page.evaluate(async (l) => (await globalThis.ElectroTag.backend.me()).catalogue.labels.find((x) => x.label === l), BLINK);
      assert.notEqual(after.description, 'A blink, in the words of our study.');
      assert.equal(after.guide, undefined);
    },
  },
];
