// Recent changes and the records (docs/admin_area.md, "Records"): a long entry shows its first lines with
// Show all, which opens it in full and Show less closes it again; a short entry has no button; the parts
// of one registration (the admin area sends 40 recordings at a time, sharing a batch_id) are one entry,
// "Registered 200 new recordings"; and a settings change names only what changed.
import { signIn, waitForRoute } from './helpers.mjs';

const recentRow = (page, text) => page.locator('.admin-section[data-section="overview"] tr', { hasText: text });

export const tests = [
  {
    name: 'recent changes: long entries open in full, and one registration sent in parts is one entry',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1400, height: 900 });
      await signIn(page, 'ADMIN');
      await waitForRoute(page, 'admin');
      await page.evaluate(async () => {
        const app = globalThis.ElectroTag;
        const b = app.backend;
        const s = (await b.admin('settings_get', {})).settings;
        // a long change: thirty channels more to hide
        await b.admin('settings_update', { settings: { channels: { hide: [...s.channels.hide, ...Array.from({ length: 30 }, (_, i) => `EXTRA_CHANNEL_NAME_${i}`)] } } });
        // a short one, with one value of a group changed
        await b.admin('settings_update', { settings: { display: { scalings: { ...s.display.scalings, eeg: 0.00007 } } } });
        // a registration of 200 recordings, sent in five parts of 40 (as recordings.js sends them)
        for (let p = 0; p < 5; p++) {
          const added = Array.from({ length: 40 }, (_, i) => `sub-${p * 40 + i}/eeg/rec.edf`);
          b._admin._audit('recordings_register', `Added ${added.length} recordings (the study)`, { scope: 'study', added, replaced: [], skipped: 0, batch_id: 'reg1' });
        }
        b._save();
      });
      await page.evaluate(() => { location.hash = '#admin-records'; });
      await waitForRoute(page, 'admin-records');
      await page.evaluate(() => { location.hash = '#admin'; });
      await waitForRoute(page, 'admin');
      await recentRow(page, 'Registered').first().waitFor();

      // One entry for the registration, with the whole count.
      assert.equal(await recentRow(page, 'recordings').count(), 1);
      assert.match(await recentRow(page, 'recordings').textContent(), /Registered 200 new recordings in study/);
      // The scale change names the one value, from and to.
      assert.match(await recentRow(page, 'scalings').textContent(), /eeg \(display scalings\) from 50 µV to 70 µV/);
      assert.equal(await recentRow(page, 'scalings').locator('.audit-more').isVisible(), false, 'a short entry has no Show all');

      // The long entry shows its first lines, and Show all opens it in full.
      const row = recentRow(page, 'hide (channels)');
      const text = row.locator('.audit-text');
      const more = row.locator('.audit-more');
      await more.waitFor({ state: 'visible' });
      const closed = await text.evaluate((el) => ({ h: el.clientHeight, full: el.scrollHeight }));
      assert.ok(closed.full > closed.h + 1, `cut to its first lines (${closed.h} of ${closed.full} pixels)`);
      await row.scrollIntoViewIfNeeded();
      await t.screenshot(page, 'recent_changes_closed');
      await more.click();
      assert.equal(await more.textContent(), 'Show less');
      assert.equal(await more.getAttribute('aria-expanded'), 'true');
      const open = await text.evaluate((el) => ({ h: el.clientHeight, full: el.scrollHeight }));
      assert.ok(open.h >= open.full - 1 && open.h > closed.h, `in full (${open.h} pixels)`);
      assert.match(await text.textContent(), /EXTRA_CHANNEL_NAME_29/);
      await t.screenshot(page, 'recent_changes_open');
      await more.click();
      assert.equal(await more.textContent(), 'Show all');

      // The records show the registration as one entry too.
      await page.evaluate(() => { location.hash = '#admin-records'; });
      await waitForRoute(page, 'admin-records');
      const rec = page.locator('.admin-section[data-section="records"] tr', { hasText: 'new recordings' });
      await rec.first().waitFor();
      assert.equal(await rec.count(), 1);
      assert.match(await rec.textContent(), /Registered 200 new recordings/);
    },
  },
];
