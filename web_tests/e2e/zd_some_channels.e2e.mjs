// Show some channels (docs/using.md, "Showing only some channels"): the EEG shows only the channels
// chosen; a drag then marks those channels, or those selected among them, and never the whole
// montage; the Edit channels dialog and Shift+click keep a mark off the whole montage; the parts on
// the screen while some good channels are hidden are kept apart from those viewed, shown dotted on
// the overview bar and in the Recording tab, kept in the draft, named by Next part not yet viewed and
// listed apart by the check before Save and Finish, whose Go to the first part shows every channel
// again. With only bad channels hidden, what is on the screen counts as viewed. S switches between
// the channels chosen and all of them; the menu of a channel's name shows only the selected ones.
import { clickDialogButton, drag, eegPoint, openExample, signIn, waitForRoute, waitForTraces } from './helpers.mjs';

/** Change the demonstration's study settings (annotation block) and read GET /me again. */
async function studySettings(page, annotation) {
  await page.evaluate(async (a) => {
    const app = globalThis.ElectroTag;
    Object.assign(app.backend._admin.s.settings.annotation, a);
    app.backend._save();
    await app.refreshMe();
  }, annotation);
}

async function events(page) {
  return page.evaluate(async () => {
    await globalThis.ElectroTag.flushLog();
    return globalThis.ElectroTag.backend.resultsDocument().interaction_logs.flatMap((l) => l.events);
  });
}

const ws = (page, fn, arg) => page.evaluate(([f, a]) => (0, eval)(f)(globalThis.ElectroTag.ws, a), [String(fn), arg]);

export const tests = [
  {
    name: 'some channels shown: marks on those channels only, and the parts seen like this asked for again',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 950 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await studySettings(page, { idle_pause_minutes: 0, break_reminder_minutes: 0 });
      await openExample(page, 0); // 70 s, 10 s on the screen
      await page.waitForFunction(() => globalThis.ElectroTag.ws.s.viewed.length === 1);
      const names = await ws(page, (w) => w.s.channels.map((c) => c.name));
      assert.ok(names.length >= 8, `enough channels (${names.length})`);
      const four = names.slice(2, 6);
      assert.equal(await page.isVisible('.ws-toolbar [data-log="channels-shown-all"]'), false, 'Show all channels only while some are hidden');

      // Shift+S opens the chooser; cancelled, nothing changes.
      await page.locator('.ws-eeg canvas').last().focus();
      await page.keyboard.press('Shift+S');
      await page.waitForSelector('.dialog');
      assert.match(await page.textContent('.dialog'), /Channels to show/);
      await clickDialogButton(page, 'Cancel');
      assert.equal(await ws(page, (w) => w.viewer.shownSubset), null);

      // The menu of a channel's name shows only the selected channels.
      await ws(page, (w, n) => { w.setScope('channels'); w.setSelectedChannels(n); }, four);
      await ws(page, (w) => w.showChannelMenu(w.viewer.channels[2].name, 300, 300));
      await page.click('.menu >> text=Show only the selected channels (4)');
      assert.deepEqual(await ws(page, (w) => w.viewer.shownSubset), four);
      assert.deepEqual(await ws(page, (w) => w.viewer.channels.map((c) => c.name)), four, 'the rows are those channels alone');
      assert.equal(await page.isVisible('.ws-toolbar [data-log="channels-shown-all"]'), true);
      assert.match(await page.textContent('.ws-message'), new RegExp(`Showing 4 of ${names.length} channels`));
      await waitForTraces(page);
      await t.screenshot(page, 'some_channels');

      // The first choice is now the channels shown: a drag marks them, never the whole montage.
      await ws(page, (w) => { w.setSelectedChannels([]); w.setScope('whole'); });
      assert.equal(await page.textContent('.ws-toolbar .seg[aria-pressed="true"]'), 'Shown channels');
      assert.match(await page.textContent('.ws-chansummary'), /the 4 channels shown/);
      await drag(page, await eegPoint(page, 1, four[1]), await eegPoint(page, 2, four[1]));
      let anns = await ws(page, (w) => w.store.annotations().map((a) => ({ label: a.label, channels: [...a.channels] })));
      assert.equal(anns.length, 1);
      assert.deepEqual(anns[0].channels, four, 'on the four channels shown');

      // Selected channels among those shown: only those; a channel not shown cannot be selected.
      await ws(page, (w, n) => { w.setScope('channels'); w.setSelectedChannels([n[0], n[3], 'not-there']); }, four);
      await ws(page, (w, n) => w.setSelectedChannels([...w.selectedChannels, n]), names[0]);
      assert.deepEqual(await ws(page, (w) => w.selectedChannels), [four[0], four[3]]);
      await drag(page, await eegPoint(page, 4, four[0]), await eegPoint(page, 5, four[0]));
      anns = await ws(page, (w) => w.store.annotations().map((a) => [...a.channels]));
      assert.deepEqual(anns[1], [four[0], four[3]]);

      // A mark is not made to cover every channel while some are hidden: no Apply to whole montage in its menu.
      const firstId = await ws(page, (w) => w.store.annotations()[0].annotation_id);
      await ws(page, (w, id) => w.showContextMenu(id, 300, 300), firstId);
      await page.waitForSelector('.menu');
      assert.equal(await page.locator('.menu >> text=Apply to whole montage').count(), 0);
      assert.equal(await page.locator('.menu >> text=Edit channels…').count(), 1);
      await page.keyboard.press('Escape');
      // an annotation on every channel but one: Shift+click on the last is refused here
      const allButOne = names.filter((n) => n !== four[2]);
      await ws(page, (w, [id, ch]) => w.store.setChannels(id, ch), [firstId, allButOne]);
      await ws(page, (w, [id, ch]) => w.toggleAnnotationChannel(id, ch), [firstId, four[2]]);
      assert.equal(await ws(page, (w, id) => w.store.get(id).channels.length, firstId), names.length - 1);
      assert.match(await page.textContent('.ws-message'), /cover every channel/);

      // What is on the screen now is kept apart: it does not count as viewed.
      const viewedBefore = await ws(page, (w) => w.s.viewed);
      await ws(page, (w) => w.viewer.setView({ startS: 30 }, 'key'));
      await page.waitForFunction(() => globalThis.ElectroTag.ws.s.viewedSome.some(([a, b]) => a <= 30 && b >= 40));
      assert.deepEqual(await ws(page, (w) => w.s.viewed), viewedBefore, 'not counted as viewed');
      assert.match(await page.textContent('.ws-viewed'), /with some channels hidden/);
      await page.click('.tab[data-tab="recording"]');
      assert.match(await page.textContent('.coverage-some'), /only while some good channels were hidden/);
      assert.match(await page.textContent('.shown-channels'), /Showing 4 of/);
      // The draft keeps them.
      await page.waitForFunction(() => {
        const w = globalThis.ElectroTag.ws;
        const d = JSON.parse(localStorage.getItem(w.s.localKey) || 'null');
        return d && Array.isArray(d.viewed_some_channels) && d.viewed_some_channels.some(([a, b]) => a <= 30 && b >= 40);
      });

      // U names the part as seen with some channels hidden, and says how to show them.
      await ws(page, (w) => w.viewer.setView({ startS: 20 }, 'key'));
      await page.locator('.ws-eeg canvas').last().focus();
      await page.keyboard.press('u');
      await page.waitForFunction(() => /Seen only with some channels hidden|Not yet viewed/.test(document.querySelector('.ws-message').textContent));

      // S shows all channels, and S again the four chosen.
      await page.keyboard.press('s');
      assert.equal(await ws(page, (w) => w.viewer.shownSubset), null);
      assert.equal(await ws(page, (w) => w.viewer.channels.length), names.length);
      await page.keyboard.press('s');
      assert.deepEqual(await ws(page, (w) => w.viewer.shownSubset), four);

      // Save and Finish lists the part seen with channels hidden apart, and Go to the first part shows every channel.
      await ws(page, (w) => { w.s.noteViewed([[0, 30], [40, 70]]); w.viewer.setCoverage(w.s.viewed, w.s.viewedSome); w._refreshCoverage(); });
      await page.click('.ws-actions button.primary');
      await page.waitForSelector('.dialog.coverage-check');
      const text = (await page.textContent('.dialog.coverage-check')).replace(/\s+/g, ' ');
      assert.match(text, /with all its good channels on the screen/);
      assert.match(text, /only while some good channels were hidden/);
      assert.match(text, /0:30 to 0:40/);
      await t.screenshot(page, 'some_channels_coverage_check');
      await clickDialogButton(page, 'Go to that part');
      assert.equal(await ws(page, (w) => w.viewer.shownSubset), null, 'every channel shown again');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.s.viewed.some(([a, b]) => a <= 30 && b >= 40), null, { timeout: 8000 });

      // With only bad channels hidden, what is on the screen counts as viewed.
      const rest = names.filter((n) => !four.includes(n));
      await ws(page, (w, r) => w.setChannelsBad(r, true), rest);
      await ws(page, (w, n) => w.setShownChannels(n, 'button'), four);
      assert.equal(await ws(page, (w) => w._showsEveryGoodChannel()), true);
      await ws(page, (w) => { w.s.noteViewed([[0, 30]]); w.viewer.setCoverage(w.s.viewed, w.s.viewedSome); w.viewer.setView({ startS: 50 }, 'key'); });
      await page.waitForFunction(() => globalThis.ElectroTag.ws.s.viewed.some(([a, b]) => a <= 50 && b >= 60));

      // The log: the channels shown, and the montage's rows on screen.
      await page.waitForTimeout(400);
      const ev = await events(page);
      const shown = ev.filter((e) => e.type === 'state' && 'shown_channels' in e);
      assert.ok(shown.some((e) => Array.isArray(e.shown_channels) && e.shown_channels.length === 4 && e.via === 'menu'));
      assert.ok(shown.some((e) => e.shown_channels === null && e.via === 'coverage_check'));
      const view = ev.filter((e) => e.type === 'view' && Array.isArray(e.montage_rows)).pop();
      assert.ok(view, 'a view with the montage rows');
      assert.deepEqual(view.montage_rows, four.map((n) => names.indexOf(n)));
      assert.equal(view.channels_shown, 4);
      const check = ev.find((e) => e.type === 'coverage_check');
      assert.equal(check.n_partly_viewed, 1);
    },
  },
];
