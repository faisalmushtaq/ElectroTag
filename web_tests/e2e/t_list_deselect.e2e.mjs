// A click on the empty space of the Annotations panel, around the list, ends the selection (docs/using.md,
// "The annotations list"): a type chosen on the top bar is then for the next mark and leaves the annotation that
// was selected as it was. A click on a row, or on one of the panel's buttons, keeps the selection.
import { openExample, signIn, waitForRoute } from './helpers.mjs';

/** Two annotations of the first quick type, the first selected through its row in the list. */
async function twoMarksOneSelected(page) {
  const first = await page.evaluate(() => {
    const ws = globalThis.ElectroTag.ws;
    const label = ws.quick[0];
    ws.store.reset([0, 1].map((i) => ({ annotation_id: `d${i}`, label, onset_sample: Math.round((2 + 3 * i) * ws.sf),
      duration_samples: Math.round(0.5 * ws.sf), channels: [], confidence: 3, note: '' })));
    ws._refreshList();
    return label;
  });
  await page.click('button.tab[data-tab="annotations"]');
  await page.click('.tab-panel[data-panel="annotations"] tr[data-id="d0"]');
  await page.waitForFunction(() => globalThis.ElectroTag.ws.selection.join() === 'd0');
  return first;
}

/** A point of the panel below its last row and its buttons, or below the rows inside the list when they leave room. */
async function emptySpot(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.tab-panel[data-panel="annotations"]');
    const wrap = panel.querySelector('.table-wrap');
    const rows = [...wrap.querySelectorAll('tbody tr[data-id]')];
    const w = wrap.getBoundingClientRect();
    const lastRow = rows[rows.length - 1].getBoundingClientRect();
    if (w.bottom - lastRow.bottom > 20) return { x: w.left + w.width / 2, y: (lastRow.bottom + w.bottom) / 2, where: 'list' };
    const p = panel.getBoundingClientRect();
    const body = panel.querySelector('.ann-body').getBoundingClientRect();
    return { x: p.left + 8, y: Math.min(p.bottom, body.bottom) - 4, where: 'panel' };
  });
}

export const tests = [
  {
    name: 'a click on the empty space around the annotations list ends the selection, and a type chosen next leaves the annotation as it was',
    async run(t) {
      const { assert } = t;
      const page = await t.newPage({ width: 1440, height: 900 });
      await signIn(page, 'A01');
      await waitForRoute(page, 'home');
      await openExample(page, 0);
      const first = await twoMarksOneSelected(page);
      // the buttons under the list keep the selection
      await page.click('.tab-panel[data-panel="annotations"] .btn-grid button:has-text("Go to")');
      assert.deepEqual(await page.evaluate(() => globalThis.ElectroTag.ws.selection), ['d0'], 'Go to keeps the selection');
      const spot = await emptySpot(page);
      const hit = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el && !el.closest('tr[data-id], button'); }, spot);
      assert.ok(hit, `the point chosen (${spot.where}) is empty space`);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForFunction(() => globalThis.ElectroTag.ws.selection.length === 0);
      assert.equal(await page.locator('.tab-panel[data-panel="annotations"] tr.selected').count(), 0, 'no row is shown selected');
      // a type on the top bar is now for the next mark
      const other = await page.evaluate(() => globalThis.ElectroTag.ws.quick[1]);
      await page.click(`.chip-btn[data-label="${other}"]`);
      const after = await page.evaluate(() => ({ labels: globalThis.ElectroTag.ws.store.annotations().map((a) => a.label), current: globalThis.ElectroTag.ws.currentLabel }));
      assert.deepEqual(after.labels, [first, first], 'the annotations keep their type');
      assert.equal(after.current, other, 'the type is chosen for the next mark');
      // and a row selects again
      await page.click('.tab-panel[data-panel="annotations"] tr[data-id="d1"]');
      await page.waitForFunction(() => globalThis.ElectroTag.ws.selection.join() === 'd1');
    },
  },
];
