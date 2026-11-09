// The topographic map beside the EEG (docs/using.md, "The topographic map"): at the top of the side panel,
// with the map at the time cursor after a click on the EEG, the mean or the RMS over the mark just drawn and
// over the selected mark, a channel marked bad greyed and left out at once, a name on pointing at an
// electrode and its channel chosen by a click, the person's own choice of signal kept for their next
// recording, and the section folded. A recording added without electrode positions has no map, nor does
// a study that turns the map off.
import { clickDialogButton, drag, eegPoint, openExample, signIn, waitForRoute } from './helpers.mjs';
import { recordEvents, sentEvents } from './l_links.e2e.mjs';

/** The map's state: its caption, the values (µV) of some channels, the channels marked bad, and its choices. */
async function topo(page) {
  return page.evaluate(() => {
    const m = globalThis.ElectroTag.ws.topo;
    if (!m) return null;
    const v = (n) => (m.values && Number.isFinite(m.values.get(n)) ? m.values.get(n) * 1e6 : null);
    return { caption: m.caption.textContent, n: m.chans.length, cz: v('Cz'), fp1: v('Fp1'), bad: m.bad ? [...m.bad] : [],
      what: m.target && m.target.what, signal: m.signal, open: m.open, hidden: m.body.hidden };
  });
}

/** Where electrode `name` is drawn, in the page's coordinates. */
async function electrode(page, name) {
  return page.evaluate((n) => {
    const m = globalThis.ElectroTag.ws.topo;
    const ch = m.chans.find((c) => c.name === n);
    const p = m._at(ch.p, m._geometry());
    const r = m.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, name);
}

const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });

export const tests = [
  {
    name: 'the topographic map: at the time cursor, the mean and RMS over a mark, bad channels greyed, electrodes named and chosen, the signal kept',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await recordEvents(page);
      await openExample(page, 0);
      await page.waitForSelector('.topo .topo-canvas');
      await until(page, () => globalThis.ElectroTag.ws.topo.caption.textContent !== '');
      let m = await topo(page);
      assert.ok(m.n >= 16, 'the EEG channels with standard names are on the map');
      assert.match(m.caption, /Click the EEG for the map at that moment/);
      assert.equal(m.open, true);

      // A click on the EEG places the time cursor: the map at that moment.
      const at = await eegPoint(page, 3.2);
      await page.mouse.click(at.x, at.y);
      await until(page, () => /^At 3\.2/.test(globalThis.ElectroTag.ws.topo.caption.textContent));
      m = await topo(page);
      assert.equal(m.what, 'moment');
      assert.ok(Number.isFinite(m.cz) && Number.isFinite(m.fp1), 'the channels have values');
      await t.screenshot(page, 'topomap_moment');

      // Scrolling the EEG afterwards leaves the map where it was clicked, with the same values.
      const values = () => page.evaluate(() => [...globalThis.ElectroTag.ws.topo.values.values()]);
      const atClick = await values();
      for (const key of ['ArrowRight', 'ArrowRight', 'PageDown']) { await page.keyboard.press(key); await page.waitForTimeout(250); }
      assert.ok(await page.evaluate(() => globalThis.ElectroTag.ws.viewer.view.startS > 0), 'the EEG has scrolled');
      await page.waitForTimeout(300);
      assert.match((await topo(page)).caption, /^At 3\.2/);
      assert.deepEqual(await values(), atClick);
      await page.evaluate(() => globalThis.ElectroTag.ws.viewer.setView({ startS: 0 }));

      // Pointing at an electrode names it.
      const fp1 = await electrode(page, 'Fp1');
      await page.mouse.move(fp1.x, fp1.y);
      await page.waitForSelector('.topo-tip:not([hidden])');
      assert.match(await page.textContent('.topo-tip'), /^Fp1: -?\d+(\.\d)? µV$/);

      // A channel marked bad is grey and left out at once.
      await page.evaluate(() => globalThis.ElectroTag.ws.store.setChannelBad('Cz', true));
      await until(page, () => { const m = globalThis.ElectroTag.ws.topo; return m.bad && m.bad.has('Cz'); });
      await page.mouse.move(...Object.values(await electrode(page, 'Cz')));
      await until(page, () => /^Cz: marked bad$/.test(document.querySelector('.topo-tip').textContent));

      // Drawing a mark shows its mean; RMS on asking; then a click on the EEG goes back to the cursor.
      await drag(page, await eegPoint(page, 4.0), await eegPoint(page, 4.6));
      await until(page, () => /^Mean over the mark just made, 4\.0\d\d s to 4\.6\d\d s/.test(globalThis.ElectroTag.ws.topo.caption.textContent));
      await page.selectOption('[data-log="topomap-measure"]', 'rms');
      await until(page, () => /^RMS over the mark just made/.test(globalThis.ElectroTag.ws.topo.caption.textContent));
      m = await topo(page);
      assert.ok(m.fp1 >= 0, 'an RMS is never negative');
      await t.screenshot(page, 'topomap_rms');
      // big enough to use in every layout: a laptop, and a tablet held upright or on its side
      const before = page.viewportSize();
      for (const [w, hgt] of [[1280, 720], [820, 1180], [1180, 820]]) {
        await page.setViewportSize({ width: w, height: hgt });
        await page.waitForTimeout(300);
        const box = await page.locator('.topo-canvas').boundingBox();
        assert.ok(box && box.width >= 200 && box.height >= 200, `the map is ${box && box.width} pixels across at ${w} by ${hgt}`);
        await t.screenshot(page, `topomap_${w}x${hgt}`);
      }
      await page.setViewportSize(before);
      // selected from the list, it is the selected mark
      await page.locator('.ann-table tbody tr[data-id]').first().click();
      await until(page, () => /^RMS over the selected mark/.test(globalThis.ElectroTag.ws.topo.caption.textContent));
      await page.keyboard.press('Escape');
      const later = await eegPoint(page, 6.5);
      await page.mouse.click(later.x, later.y);
      await until(page, () => /^At 6\.5/.test(globalThis.ElectroTag.ws.topo.caption.textContent));

      // A click on an electrode chooses its channel on the EEG.
      const o1 = await electrode(page, 'O1');
      await page.mouse.click(o1.x, o1.y);
      await until(page, () => globalThis.ElectroTag.ws.selectedChannels.includes('O1') && globalThis.ElectroTag.ws.scope === 'channels');

      // The person's own signal: the average reference, kept for their next recording.
      await page.click('[data-log="topomap-signal-toggle"]');
      await page.selectOption('[data-log="topomap-reference"]', 'average');
      assert.match(await page.textContent('[data-log="topomap-signal-toggle"]'), /reference average of the good channels/);
      await until(page, () => /Your own choice of signal/.test(document.querySelector('.topo-signal-note').textContent));
      const events = (await sentEvents(page)).filter((e) => e.type === 'topomap');
      for (const a of ['show', 'measure', 'channel', 'signal']) assert.ok(events.some((e) => e.action === a), `a topomap ${a} event`);
      assert.ok(events.find((e) => e.action === 'channel').channel === 'O1');
      const available = (await sentEvents(page)).find((e) => e.type === 'topomap_available');
      assert.equal(available.shown, true);
      assert.equal(available.source, 'standard');

      // Folded, it stays folded.
      await page.click('[data-log="topomap-toggle"]');
      m = await topo(page);
      assert.equal(m.hidden, true);
      assert.equal(await page.getAttribute('[data-log="topomap-toggle"]', 'aria-expanded'), 'false');

      // The next recording opens with the same choices.
      await page.click('.ws-title .back');
      await clickDialogButton(page, 'Close and finish later');
      await waitForRoute(page, 'home');
      await openExample(page, 1);
      await page.waitForSelector('.topo');
      m = await topo(page);
      assert.equal(m.signal.reference, 'average');
      assert.equal(m.hidden, true);
      await page.click('[data-log="topomap-toggle"]');
      assert.equal((await topo(page)).hidden, false);
    },
  },
  {
    name: 'no topographic map for a recording added without electrode positions, nor when the study turns the map off',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage();
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      // The positions chosen when the recording was added come with its manifest.
      const shown = await page.evaluate(async () => {
        const { topoPositions } = await import('./js/viewer/topo.js');
        const chans = ['Fp1', 'Cz', 'O1', 'O2'].map((name) => ({ name, type: 'eeg' }));
        return [topoPositions(chans, { source: 'none' }).source, topoPositions(chans, { source: 'standard' }).points.size];
      });
      assert.deepEqual(shown, ['none', 4]);
      // A study that turns the map off.
      await page.evaluate(() => { globalThis.ElectroTag.me.study.display = { ...(globalThis.ElectroTag.me.study.display || {}), topomap: false }; });
      await openExample(page, 0);
      await page.waitForFunction(() => globalThis.ElectroTag.ws.electrodes !== undefined || true);
      await page.waitForTimeout(500);
      assert.equal(await page.locator('.topo').count(), 0);
      assert.equal(await page.evaluate(() => Boolean(globalThis.ElectroTag.ws.topo)), false);
    },
  },
];
