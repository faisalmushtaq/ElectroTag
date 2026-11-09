// The platform tour for everyone (docs/using.md, "Before your first recording"): offered once on the home page to
// someone outside a training programme, with Skip, and kept for the account; and a selected annotation brought
// back into view before a change applies to it ("Changing annotations").
import { signIn, waitForRoute, waitForTraces, eegPoint, drag } from './helpers.mjs';

export const tests = [
  {
    name: 'the tour is offered once on the home page, can be skipped, and taken later from there',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      const offer = page.locator('[data-part="tour-offer"]');
      await offer.waitFor();
      assert.match(await offer.textContent(), /Before your first recording: a short tour/);
      assert.equal(await page.locator('.tour-line').count(), 0);
      await t.screenshot(page, 'tour_offer');
      await offer.locator('[data-log="tour-skip"]').click();
      await page.waitForSelector('.tour-line');
      assert.equal(await offer.count(), 0, 'skipped: not offered again');
      // kept for the account: not offered again after a reload
      await page.reload();
      await waitForRoute(page, 'home');
      await page.waitForSelector('.tour-line');
      assert.equal(await page.locator('[data-part="tour-offer"]').count(), 0);
      // taken later from the home page: its last step ends it and the home page comes back
      await page.click('[data-log="tour-again"]');
      await waitForRoute(page, 'annotate');
      await page.waitForSelector('.coach.tour');
      assert.match(await page.textContent('.coach.tour'), /Step 1 of 7/);
      for (let i = 0; i < 6; i++) {
        const n = i + 2;
        await page.click('.coach.tour [data-log="tour-skip-step"]');
        await page.waitForFunction((k) => new RegExp(`Step ${k} of 7`).test(document.querySelector('.coach.tour').textContent), n);
      }
      await page.click('[data-log="tour-save"]');
      await waitForRoute(page, 'home');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.me.tour), 'done');
      assert.match(await page.textContent('.tour-line'), /Take the tour of the annotation view again/);
    },
  },
  {
    name: 'a selected annotation scrolled out of view is brought back before a type key changes it',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await page.click('[data-log="open-next"]');
      await waitForRoute(page, 'open');
      await page.locator('.example-card button').click();
      await waitForRoute(page, 'annotate');
      await waitForTraces(page);
      await page.keyboard.press('1');
      await drag(page, await eegPoint(page, 3.0), await eegPoint(page, 3.5));
      const at = await eegPoint(page, 3.25);
      await page.mouse.click(at.x, at.y); // selected
      await page.waitForFunction(() => globalThis.ElectroTag.ws.selection.length === 1);
      const id = await page.evaluate(() => globalThis.ElectroTag.ws.selection[0]);
      assert.ok(id, 'the new mark is selected');
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer.view.startS >= 15);
      await page.keyboard.press('3');
      await page.waitForFunction(() => { const v = globalThis.ElectroTag.ws.viewer.view; return v.startS <= 3 && v.startS + v.durationS >= 3.5; });
      assert.equal(await page.evaluate((i) => globalThis.ElectroTag.ws.store.get(i).label, id), 'EMG-artifact');
      assert.match(await page.textContent('.ws-status'), /Changed the selected annotation to EMG-artifact, brought back into view/);
      // on screen already: the view stays where it is
      const before = await page.evaluate(() => globalThis.ElectroTag.ws.viewer.view.startS);
      await page.keyboard.press('1');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.viewer.view.startS), before);
    },
  },
];
