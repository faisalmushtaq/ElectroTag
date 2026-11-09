// The side panel on a laptop screen (docs/using.md, "The annotation view"): its edge is dragged to widen it, and
// once wide the topographic map sits beside the tabs, which take the panel's whole height; the width is
// remembered, the arrow keys move the edge, a double click goes back to the usual width, and the button at the
// top of the edge hides the panel for an EEG across the window, which Help brings back. On a wide screen the
// toolbar keeps to one line.
import { signIn, waitForRoute, waitForTraces, clickDialogButton } from './helpers.mjs';
import { recordEvents, sentEvents } from './l_links.e2e.mjs';

const box = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, sel);

async function openNext(page) {
  await page.click('[data-log="open-next"]');
  await waitForRoute(page, 'open');
  await page.locator('.example-card button').click();
  await waitForRoute(page, 'annotate');
  await waitForTraces(page);
}

async function closeToHome(page) {
  await page.click('[data-log="close"]');
  await clickDialogButton(page, /Close and finish later|Discard and close|^Close$/);
  await waitForRoute(page, 'home');
}

export const tests = [
  {
    name: 'the side panel is widened by its edge, sets the map beside the tabs, is remembered and hides for a full-width EEG',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1280, height: 720 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openNext(page);
      await recordEvents(page);
      const usual = await box(page, '.ws-side');
      assert.ok(Math.abs(usual.w - 360) <= 1, `the usual width on a laptop (${usual.w})`);
      assert.equal(await page.locator('.ws-side.wide').count(), 0);
      const grip = page.locator('.ws-side-grip[role="separator"]');
      // (the panel's width is said a frame after a change of size: side_panel.js)
      await page.waitForFunction((w) => document.querySelector('.ws-side-grip').getAttribute('aria-valuenow') === w, String(Math.round(usual.w)));

      // dragged 320 pixels to the left: the panel is wide, the map on the left and the tabs on the right, as tall as the panel
      const g = await grip.boundingBox();
      await page.mouse.move(g.x + g.width / 2, g.y + 200);
      await page.mouse.down();
      await page.mouse.move(g.x + g.width / 2 - 320, g.y + 200, { steps: 6 });
      await page.mouse.up();
      await page.waitForSelector('.ws-side.wide');
      const side = await box(page, '.ws-side');
      assert.ok(Math.abs(side.w - (usual.w + 320)) <= 2, `widened by the drag (${side.w})`);
      const topo = await box(page, '.topo-host');
      const tabs = await box(page, '.side-tabs');
      assert.ok(topo.x + topo.w <= tabs.x, 'the map beside the tabs');
      assert.ok(Math.abs(tabs.y - topo.y) <= 1 && tabs.h > side.h - 24, 'the tabs take the panel\'s height');
      assert.ok((await box(page, '.ws-eeg')).w >= 480, 'the EEG keeps its width');
      await t.screenshot(page, 'side_panel_wide');

      // the arrow keys move the edge; the view keeps the arrow key for itself
      const startS = await page.evaluate(() => globalThis.ElectroTag.ws.viewer.view.startS);
      await grip.focus();
      await page.keyboard.press('ArrowRight');
      assert.ok(Math.abs((await box(page, '.ws-side')).w - (side.w - 20)) <= 2, 'narrowed by 20 pixels');
      assert.equal(await page.evaluate(() => globalThis.ElectroTag.ws.viewer.view.startS), startS, 'the EEG did not move');
      const kept = (await box(page, '.ws-side')).w;

      // folding the map gives its column back to the tabs
      await page.click('.topo-toggle');
      await page.waitForFunction(() => {
        const s = document.querySelector('.ws-side').getBoundingClientRect();
        return Math.abs(document.querySelector('.side-tabs').getBoundingClientRect().width - (s.width - 8)) <= 2;
      });
      await page.click('.topo-toggle');

      // hidden: the EEG takes the window, and stays so for the next recording
      await page.click('.ws-side-toggle');
      await page.waitForFunction(() => document.querySelector('.view.annotate').classList.contains('side-hidden'));
      assert.equal(await page.locator('.ws-side').isHidden(), true);
      assert.ok((await box(page, '.ws-eeg')).w > 1200, 'the EEG across the window');
      assert.equal(await page.locator('.ws-side-toggle').getAttribute('aria-label'), 'Show the side panel');
      await t.screenshot(page, 'side_panel_hidden');
      const states = (await sentEvents(page)).filter((e) => e.type === 'state' && e.side_panel).map((e) => [e.via, e.side_panel.hidden]);
      assert.deepEqual(states, [['drag', false], ['key', false], ['button', true]]);
      await closeToHome(page);
      await openNext(page);
      assert.equal(await page.locator('.ws-side').isHidden(), true, 'still hidden');
      // Help brings it back, at the width it was given
      await page.keyboard.press('?');
      await page.waitForFunction(() => !document.querySelector('.view.annotate').classList.contains('side-hidden'));
      assert.equal(await page.locator('.tab[data-tab="help"]').getAttribute('aria-selected'), 'true');
      assert.ok(Math.abs((await box(page, '.ws-side')).w - kept) <= 2, 'the width remembered');

      // a double click goes back to the usual width
      await page.locator('.ws-side-grip').dblclick();
      await page.waitForFunction((w) => Math.abs(document.querySelector('.ws-side').getBoundingClientRect().width - w) <= 1, usual.w);
      await page.waitForFunction(() => !document.querySelector('.ws-side.wide'));
    },
  },
  {
    name: 'on a wide screen the toolbar keeps to one line',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1920, height: 1080 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openNext(page);
      const tb = await box(page, '.ws-toolbar');
      assert.ok(tb.h <= 50, `one line (${tb.h} pixels)`);
      // choosing channels brings their summary back into the line
      await page.locator('.seg', { hasText: 'Selected channels' }).click();
      assert.equal(await page.locator('.ws-chansummary').isVisible(), true);
      assert.match(await page.textContent('.ws-chansummary'), /none selected/);
    },
  },
];
