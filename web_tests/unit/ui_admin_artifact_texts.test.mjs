// Artifact type descriptions (js/admin/artifact_texts.js) and the guide with the study's own words
// (js/guide/artifacts.js guideOf, ownGuide): what a form sends, and what the guide shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fieldChanges, originalOf } from '../../electrotag/web/static/js/admin/artifact_texts.js';
import { GUIDE, guideMatches, guideOf, ownGuide } from '../../electrotag/web/static/js/guide/artifacts.js';

const BLINK = 'Eye-blink-artifact';

test('a form sends only what changed: words of the study\'s own, or null for the original again', () => {
  const original = originalOf(BLINK, { [BLINK]: 'Artifact from eye blinking.' });
  assert.equal(original.description, 'Artifact from eye blinking.');
  assert.equal(original.where, GUIDE[BLINK].where);
  assert.deepEqual(original.apart, GUIDE[BLINK].apart);
  const shown = { ...original, shape: 'Our shape.' };
  assert.deepEqual(fieldChanges({ ...shown }, shown, original), {}, 'nothing changed');
  assert.deepEqual(fieldChanges({ ...shown, description: '  A blink, as we see it.  ' }, shown, original), { description: 'A blink, as we see it.' });
  assert.deepEqual(fieldChanges({ ...shown, shape: GUIDE[BLINK].shape }, shown, original), { shape: null }, 'the original typed again');
  const apart = [...original.apart, ['EMG-artifact', 'is fast.'], ['', 'no type'], ['ECG-artifact', '  ']];
  assert.deepEqual(fieldChanges({ ...shown, apart }, shown, original), { apart: [...original.apart, ['EMG-artifact', 'is fast.']] });
  assert.deepEqual(fieldChanges({ ...shown, apart: original.apart }, { ...shown, apart: [] }, original), { apart: null });
});

test('the guide shows the study\'s own words where it changed them, and finds them', () => {
  const me = { catalogue: { labels: [{ label: BLINK, description: 'x', guide: { shape: 'A quick dip.', apart: [['EMG-artifact', 'is fast.']] } }, { label: 'EMG-artifact' }] } };
  const own = ownGuide(me);
  assert.deepEqual(Object.keys(own), [BLINK]);
  const g = guideOf(BLINK, own);
  assert.equal(g.shape, 'A quick dip.');
  assert.equal(g.where, GUIDE[BLINK].where, 'the rest as it was');
  assert.deepEqual(g.example, GUIDE[BLINK].example, 'the example picture stays');
  assert.equal(guideOf(BLINK, null), GUIDE[BLINK]);
  assert.equal(guideMatches({ label: BLINK, description: 'x' }, 'quick dip', own), true);
  assert.equal(guideMatches({ label: BLINK, description: 'x' }, 'quick dip'), false);
});
