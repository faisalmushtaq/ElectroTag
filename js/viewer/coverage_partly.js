// The parts of a recording on screen only while some good channels were hidden (Show some channels in
// the annotation view), beside those of coverage.js: kept as a second merged list of the same kind,
// they count as viewed only once they have been on the screen with every good channel. Kept apart
// from coverage.js, which the sign-in page loads.
import { MIN_UNVIEWED_S, mergeIntervals, unviewed, viewedFraction } from './coverage.js';

/** The parts two merged lists have in common (merged). */
export function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return mergeIntervals(out);
}

/**
 * The stretches still to view (unviewed, from the parts seen with every good channel on the screen)
 * that were on the screen only while some good channels were hidden (`partly`, a merged list), at
 * least `minS` seconds long: the parts to look at again with all the channels shown.
 */
export function partlyViewed(list, partly, totalS, { noData = [], minS = MIN_UNVIEWED_S } = {}) {
  const gaps = unviewed(list, totalS, { noData, minS: 0 });
  return intersect(gaps, mergeIntervals(partly || [])).filter(([a, b]) => b - a >= minS - 1e-9);
}

/** The share of the recording (0 to 1) on screen only while some good channels were hidden. */
export function partlyFraction(list, partly, totalS, noData = []) {
  const all = viewedFraction(mergeIntervals([...list, ...(partly || [])]), totalS, noData);
  return Math.max(0, all - viewedFraction(list, totalS, noData));
}
