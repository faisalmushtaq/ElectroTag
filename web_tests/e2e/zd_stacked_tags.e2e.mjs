// The tags above the traces (docs/using.md, "The annotation view"): two marks over the same moment keep their
// whole names in the two rows of tags; from the third, the tags of that stretch are cut to their types' numbers
// and set side by side, each still selecting its mark and naming it in full under the pointer.
import { signIn, waitForRoute, waitForTraces, eegPoint, drag } from './helpers.mjs';

const tags = (page) => page.evaluate(() => globalThis.ElectroTag.ws.viewer._tags.map((t) => ({ ...t })));

export const tests = [
  {
    name: 'three marks over one moment: their tags are cut to their numbers, side by side, and still select their marks',
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
      await page.keyboard.press('Escape'); // (a drag from inside the selected mark would move it)
      await page.keyboard.press('3');
      await drag(page, await eegPoint(page, 3.1), await eegPoint(page, 3.6));
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer._tags.length === 2);
      let now = await tags(page);
      assert.equal(now.length, 2);
      assert.ok(now.every((x) => !x.short), 'two: whole names');
      await page.keyboard.press('Escape');
      await page.keyboard.press('4');
      await drag(page, await eegPoint(page, 3.2), await eegPoint(page, 3.7));
      await page.waitForFunction(() => globalThis.ElectroTag.ws.viewer._tags.length === 3);
      now = await tags(page);
      assert.ok(now.every((x) => x.short), 'three: cut to their numbers');
      assert.ok(now.every((x) => x.y === now[0].y), 'side by side in one row');
      const xs = now.map((x) => x.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] + now[0].w, 'not over one another');
      await t.screenshot(page, 'stacked_tags');
      // under the pointer, a cut tag names its mark in full; clicked, it selects it
      await page.keyboard.press('Escape');
      const r = await page.locator('canvas.layer.top').boundingBox();
      const first = now[0];
      await page.mouse.move(r.x + first.x + first.w / 2, r.y + first.y + first.h / 2);
      await page.waitForFunction((full) => document.querySelector('canvas.layer.top').title === full, first.full);
      await page.mouse.click(r.x + first.x + first.w / 2, r.y + first.y + first.h / 2);
      await page.waitForFunction((id) => globalThis.ElectroTag.ws.viewer.selected.has(id), first.id);
    },
  },
];
