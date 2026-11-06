// The probability map of several raters' marks on one recording, without the page (docs/admin_area.md,
// "Probability maps"), as electrotag/reliability/probability.py works it out: at every sample, the weighted
// share of the raters who marked an artifact there,
//
//   p(t) = sum_r w_r * c_r(t) * m_r(t) / sum_r w_r * c_r(t)
//
// with w_r the product of the weights of the rater's questionnaire answers chosen, c_r(t) the weight of the
// confidence of their mark there (the most confident where marks overlap; full weight for a mark without one
// and for unmarked time) and m_r(t) 1 where they marked and 0 where they did not. The map is a list of runs
// of samples [start, end) with one value each. Raters are summed in the order of their IDs, as Python sums
// them, so both give the same numbers (web_tests/unit/ui_probability.test.mjs compares them).

/** Every mark, whatever its type. */
export const ANY = 'any';
/** The weights of confidence 1 to 5 by default. */
export const CONFIDENCE_DEFAULT = Object.freeze([0.2, 0.4, 0.6, 0.8, 1.0]);
/** The fewest raters a map is made from; a map from exactly this many is a small sample. */
export const MIN_RATERS = 2;

/** The weights everyone starts with: confidence 20 % to 100 %, no questions, no answer at full weight. */
export function defaultWeights() {
  return { confidence: [...CONFIDENCE_DEFAULT], questions: {}, no_answer: 1 };
}

/** A mark's weight for its confidence: full weight when it has none. */
export function confidenceWeight(weights, confidence) {
  const c = Number(confidence);
  return Number.isInteger(c) && c >= 1 && c <= 5 ? weights.confidence[c - 1] : 1;
}

/** The product of the weights of a rater's answers to the questions chosen (in the order of their IDs); 1 when none is. */
export function raterWeight(answers, weights) {
  let w = 1;
  for (const qid of Object.keys(weights.questions || {}).sort(byCode)) {
    const given = (answers || {})[qid];
    const table = weights.questions[qid] || {};
    w *= typeof given === 'string' && Object.prototype.hasOwnProperty.call(table, given) ? table[given] : weights.no_answer;
  }
  return w;
}

/** Text in the order Python sorts it (by code point). */
function byCode(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

const counts = (m, category, channel) => (category === ANY || m.label === category) && (channel === null || !m.channels.length || m.channels.includes(channel));

/** A rater's matching marks as pieces that do not overlap, each with the largest confidence weight there. */
function pieces(spans) {
  const cuts = [...new Set(spans.flatMap(([a, b]) => [a, b]))].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    let best = null;
    for (const [s, e, c] of spans) if (s <= a && a < e && (best === null || c > best)) best = c;
    if (best !== null) out.push([a, cuts[i + 1], best]);
  }
  return out;
}

/**
 * The map of `raters` ([{annotator_id, weight, marks: [{label, onset, duration, channels, confidence}]}]) over
 * samples 0 to nSamples: [{start, end, p (null when every rater weighs 0), n_marked, weight_total, weight_marked}].
 */
export function runs(raters, nSamples, weights, { category = ANY, channel = null } = {}) {
  const rs = [...raters].sort((a, b) => byCode(a.annotator_id, b.annotator_id));
  const edges = new Set([0, nSamples]);
  const all = rs.map((r) => {
    const mine = [];
    for (const m of r.marks) {
      if (!counts(m, category, channel)) continue;
      const a = Math.max(0, m.onset);
      const b = Math.min(nSamples, m.onset + Math.max(1, m.duration));
      if (b > a) mine.push([a, b, confidenceWeight(weights, m.confidence)]);
    }
    const p = pieces(mine);
    for (const [a, b] of p) { edges.add(a); edges.add(b); }
    return p;
  });
  const cuts = [...edges].filter((e) => e >= 0 && e <= nSamples).sort((x, y) => x - y);
  const at = new Array(rs.length).fill(0);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    let num = 0;
    let den = 0;
    let marked = 0;
    for (let k = 0; k < rs.length; k++) {
      const mine = all[k];
      let j = at[k];
      while (j < mine.length && mine[j][1] <= a) j++;
      at[k] = j;
      if (j < mine.length && mine[j][0] <= a) {
        const c = mine[j][2];
        den += rs[k].weight * c;
        num += rs[k].weight * c;
        marked++;
      } else den += rs[k].weight;
    }
    const p = den > 0 ? num / den : null;
    const last = out[out.length - 1];
    if (last && last.p === p && last.n_marked === marked && last.weight_total === den && last.weight_marked === num) last.end = b;
    else out.push({ start: a, end: b, p, n_marked: marked, weight_total: den, weight_marked: num });
  }
  return out;
}

/** The value of a map at sample s, and its run. */
export function runAt(map, s) {
  let lo = 0;
  let hi = map.length - 1;
  if (hi < 0 || s < map[0].start) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map[mid].start <= s) lo = mid; else hi = mid - 1;
  }
  return s < map[lo].end ? map[lo] : null;
}

/**
 * probability_get's answer as raters for `runs`, with the weights of their answers: the marks come in the
 * overlay's compact form (js/expert/crowd.js decode), each with its channels by name.
 */
export function ratersOf(data, answers, weights) {
  return data.people.map((p) => ({
    annotator_id: p.annotator_id, source: p.source, set_id: p.set_id ?? null,
    weight: raterWeight(answers[p.annotator_id] || {}, weights),
    marks: p.marks.map((m) => ({ label: m.label, onset: m.onset, duration: m.dur, channels: data.setChannels[m.set].map((i) => data.channels[i]),
      confidence: m.conf })),
  }));
}

/** Weights read back from a browser's storage, checked; the defaults where anything is missing or wrong. */
export function checkedWeights(w) {
  const d = defaultWeights();
  if (!w || typeof w !== 'object') return d;
  const num = (x, hi) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= hi ? x : null);
  const conf = Array.isArray(w.confidence) && w.confidence.length === 5 && w.confidence.every((x) => num(x, 1) !== null) ? [...w.confidence] : d.confidence;
  const questions = {};
  for (const [q, t] of Object.entries(w.questions && typeof w.questions === 'object' ? w.questions : {})) {
    if (!t || typeof t !== 'object') continue;
    questions[q] = Object.fromEntries(Object.entries(t).filter(([, x]) => num(x, 10) !== null));
  }
  return { confidence: conf, questions, no_answer: num(w.no_answer, 10) ?? 1 };
}
