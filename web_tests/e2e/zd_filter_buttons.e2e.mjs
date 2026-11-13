// No high-pass and No notch in the annotation toolbar (docs/using.md, "The toolbar"): each shows the EEG
// without that filter while pressed and with it again when pressed once more, the side panel's viewing options follow,
// and each press is logged as a state event naming the filter and whether it is applied (docs/activity_logs.md).
import { signIn, waitForRoute, openExample } from './helpers.mjs';

export const tests = [
  {
    name: 'the toolbar shows the EEG without the high-pass or the notch filter, and the log records each press',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1600, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      const hp = page.locator('[data-log="without-highpass"]');
      const notch = page.locator('[data-log="without-notch"]');
      const filters = () => page.evaluate(() => ({ ...globalThis.ElectroTag.ws.s.filters }));
      assert.equal(await hp.getAttribute('aria-pressed'), 'false', 'filtered at first');
      assert.equal(await notch.getAttribute('aria-pressed'), 'false');
      assert.deepEqual(await filters(), { highpassHz: 1, notchHz: 50, notchHarmonics: false });

      await hp.click();
      assert.equal(await hp.getAttribute('aria-pressed'), 'true');
      assert.deepEqual(await filters(), { highpassHz: null, notchHz: 50, notchHarmonics: false });
      assert.equal(await page.isChecked('#hp-off'), true, 'the side panel follows');
      await t.screenshot(page, 'toolbar_without_highpass');
      await notch.click();
      assert.deepEqual(await filters(), { highpassHz: null, notchHz: null, notchHarmonics: false });
      assert.equal(await page.isChecked('#notch-on'), false);
      await notch.click();
      await hp.click();
      assert.deepEqual(await filters(), { highpassHz: 1, notchHz: 50, notchHarmonics: false }, 'both back as they were');
      assert.equal(await hp.getAttribute('aria-pressed'), 'false');
      // the side panel's options and the buttons are one setting
      await page.evaluate(() => document.querySelector('#hp-off').click()); // (in the Recording tab of the side panel)
      assert.equal(await hp.getAttribute('aria-pressed'), 'true');
      await hp.click();

      await page.evaluate(() => globalThis.ElectroTag.flushLog());
      const events = await page.evaluate(() => [...globalThis.ElectroTag.backend.visits.values()].flatMap((v) => v.events));
      const pressed = events.filter((e) => e.type === 'state' && e.filter).map((e) => [e.filter, e.applied, e.via, e.filters.highpass_hz, e.filters.notch_hz]);
      assert.deepEqual(pressed, [['highpass', false, 'button', null, 50], ['notch', false, 'button', null, null], ['notch', true, 'button', null, 50],
        ['highpass', true, 'button', 1, 50], ['highpass', true, 'button', 1, 50]]);
      assert.ok(events.some((e) => e.type === 'state' && e.filters && !e.filter && e.filters.highpass_hz === null), 'the side panel\'s change is logged too');
    },
  },
];
