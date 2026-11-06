// The probability maps in the sandbox (docs/api.md, "Probability maps"), as electrotag/web/probability.py
// gives them on a server: the raters of a recording (everyone's latest study work kept in this browser), their
// answers to the questionnaire as they stood when they saved it, the map of one recording and the maps of every
// recording as files. The sandbox keeps no experts' files with its training references, so its raters are
// study work only. Loaded with the dataset library's part (demo_library.js), for administrators.

import { ApiError } from './http.js';
import { zipBytes } from '../data/zip.js';
import { pyFloatRepr } from '../eeg/pyfmt.js';
import { nowLocalIso } from '../util.js';
import { PREFER_NOT, PREFER_NOT_LABEL } from '../views/questionnaire_model.js';
import { ANY, MIN_RATERS, raterWeight, runs } from '../expert/probability.js';
import { rangesText } from './demo_overlay.js';
import { CATALOGUE } from './demo_catalogue.js';

const COLUMNS = ['category', 'channel', 'start_sample', 'end_sample', 'onset', 'duration', 'probability', 'n_raters', 'n_marked', 'weight_total', 'weight_marked'];
const bad = (message, code = 'bad_request', status = 400) => new ApiError(status, code, message);
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** probability.py Weights.from_dict: the weights asked for, checked in the same words. */
export function checkWeights(d) {
  if (d === undefined || d === null) return { confidence: [0.2, 0.4, 0.6, 0.8, 1.0], questions: {}, no_answer: 1 };
  if (typeof d !== 'object' || Array.isArray(d)) throw bad('weights must be an object with confidence, questions and no_answer');
  const unknown = Object.keys(d).filter((k) => !['confidence', 'questions', 'no_answer'].includes(k)).sort(byCode);
  if (unknown.length) throw bad(`weights has no setting '${unknown[0]}'`);
  const num = (x, what, hi = 10) => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > hi) throw bad(`${what} must be a number from 0 to ${hi}`);
    return x;
  };
  const conf = d.confidence === undefined ? [0.2, 0.4, 0.6, 0.8, 1.0] : d.confidence;
  if (!Array.isArray(conf) || conf.length !== 5) throw bad('confidence must give the weights of confidence 1 to 5, five numbers from 0 to 1');
  const confidence = conf.map((x, i) => num(x, `The weight of confidence ${i + 1}`, 1));
  const qs = d.questions || {};
  if (typeof qs !== 'object' || Array.isArray(qs)) throw bad('questions must be an object: for each question, the weight of each answer');
  const questions = {};
  for (const [q, answers] of Object.entries(qs)) {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw bad(`The weights of the answers to '${q}' must be an object`);
    questions[q] = Object.fromEntries(Object.entries(answers).map(([a, w]) => [a, num(w, `The weight of the answer '${a}' to '${q}'`)]));
  }
  return { confidence, questions, no_answer: num(d.no_answer === undefined ? 1 : d.no_answer, 'The weight of no answer') };
}

/** The weights as probability.json records them (Python's to_dict: questions in order, numbers as floats). */
function weightsJson(w) {
  return { confidence: [...w.confidence], questions: Object.fromEntries(Object.keys(w.questions).sort(byCode).map((q) => [q, { ...w.questions[q] }])),
    no_answer: w.no_answer };
}

const instant = (t) => { const v = Date.parse(t || ''); return Number.isFinite(v) ? v : 0; };

export class Probability {
  constructor(lib) {
    this.lib = lib;
    this.b = lib.b;
  }

  async questions() {
    const part = await this.b._questionnairePart();
    return part.questions().filter((q) => q.type === 'choice').map((q) => ({ id: q.id, text: q.text || '',
      options: [...(q.options || []).map((o) => ({ value: String(o), label: String(o) })), { value: PREFER_NOT, label: PREFER_NOT_LABEL }] }));
  }

  /** questionnaire.py answers_at: the entry current when the work was saved (the earliest when none was yet). */
  async answersAt(aid, when) {
    const part = await this.b._questionnairePart();
    const h = ((part.record(aid) || {}).history) || [];
    if (!h.length) return {};
    const before = h.filter((x) => !when || instant(x.at) <= instant(when));
    const entry = before.length ? before[before.length - 1] : h[0];
    return Object.fromEntries(Object.entries(entry.answers || {}).filter(([, v]) => typeof v === 'string'));
  }

  raters(rid) {
    const latest = new Map();
    for (const s of this.b.state.submissions) {
      if (s.recording_id !== rid || s.mode !== 'standard') continue;
      if (!latest.has(s.annotator_id) || latest.get(s.annotator_id).attempt < s.attempt) latest.set(s.annotator_id, s);
    }
    return [...latest.values()].sort((p, q) => byCode(p.annotator_id, q.annotator_id)).map((s) => ({ annotator_id: s.annotator_id, source: 'study', set_id: null,
      saved_at: s.saved_at || null, annotations: [...(s.annotations || [])].sort((x, y) => x.onset_sample - y.onset_sample || x.duration_samples - y.duration_samples
        || byCode(String(x.label), String(y.label)) || byCode(String(x.annotation_id || ''), String(y.annotation_id || ''))) }));
  }

  recording(rid) {
    if (typeof rid !== 'string' || !rid.trim() || rid.length > 500) throw bad('recording_id is missing');
    const info = this.b._recordingInfo(rid);
    if (!info) throw bad(`${rid} is not a registered recording of this study`, 'unknown_recording', 404);
    return info;
  }

  async get(body) {
    const rid = body.recording_id;
    if (body.set_id) throw bad('The sandbox keeps no experts\' files with its training references', 'needs_server', 501);
    const info = this.recording(rid);
    const ch = [...info.ch_names];
    const at = new Map(ch.map((n, i) => [n, i]));
    const labels = [];
    const sets = [''];
    const people = [];
    for (const p of this.raters(rid)) {
      const flat = [];
      let prev = 0;
      for (const a of p.annotations) {
        let l = labels.indexOf(a.label);
        if (l < 0) { l = labels.length; labels.push(a.label); }
        const key = rangesText((a.channels || []).filter((c) => at.has(c)).map((c) => at.get(c)));
        let s = sets.indexOf(key);
        if (s < 0) { s = sets.length; sets.push(key); }
        flat.push(l, a.onset_sample - prev, a.duration_samples, s, Number.isInteger(a.confidence) ? a.confidence : 0);
        prev = a.onset_sample;
      }
      people.push({ annotator_id: p.annotator_id, source: p.source, set_id: p.set_id, saved_at: p.saved_at, answers: await this.answersAt(p.annotator_id, p.saved_at), marks: flat });
    }
    return { recording_id: rid, scope: 'study', file_name: info.file_name, sfreq: Number(info.sfreq), n_samples: Number(info.n_samples), channels: ch,
      labels, sets, people, questions: await this.questions(), min_raters: MIN_RATERS };
  }

  async export(body, me) {
    const weights = checkWeights(body.weights);
    const least = body.min_raters === undefined ? MIN_RATERS : body.min_raters;
    if (!Number.isInteger(least) || least < MIN_RATERS || least > 10000) throw bad(`min_raters is a whole number of ${MIN_RATERS} or more: a map needs at least two raters`);
    const category = body.category || ANY;
    const labels = CATALOGUE.labels.map((l) => l.label);
    if (typeof category !== 'string' || (![ANY, 'each'].includes(category) && !labels.includes(category))) {
      throw bad('category is any, each, or a HED-SCORE type of the study\'s catalogue');
    }
    const byChannel = body.by_channel === undefined ? false : body.by_channel;
    if (typeof byChannel !== 'boolean') throw bad('by_channel is true or false');
    if (body.set_id) throw bad('The sandbox keeps no experts\' files with its training references', 'needs_server', 501);
    let rids;
    if (body.recording_ids !== undefined && body.recording_ids !== null) {
      if (!Array.isArray(body.recording_ids) || !body.recording_ids.every((r) => typeof r === 'string' && r)) throw bad('recording_ids is a list of recording IDs');
      rids = body.recording_ids;
      rids.forEach((r) => this.recording(r));
    } else rids = this.b._admin.s.recordings.filter((r) => r.scope === 'study').map((r) => r.recording_id).sort(byCode);
    const files = {};
    const listed = {};
    const tooFew = [];
    for (const rid of rids) {
      const people = this.raters(rid);
      if (people.length < least) { tooFew.push(rid); continue; }
      const info = this.recording(rid);
      const names = [...info.ch_names];
      const raters = [];
      for (const p of people) {
        raters.push({ annotator_id: p.annotator_id, source: p.source, weight: raterWeight(await this.answersAt(p.annotator_id, p.saved_at), weights),
          marks: p.annotations.map((a) => ({ label: a.label, onset: a.onset_sample, duration: a.duration_samples, channels: [...(a.channels || [])],
            confidence: Number.isInteger(a.confidence) && a.confidence ? a.confidence : null })) });
      }
      const cats = category === ANY ? [ANY] : category !== 'each' ? [category] : [ANY, ...[...new Set(raters.flatMap((r) => r.marks.map((m) => m.label)))].sort(byCode)];
      const rows = [];
      const n = Number(info.n_samples);
      const sf = Number(info.sfreq);
      const block = (c, ch) => {
        for (const r of runs(raters, n, weights, { category: c, channel: ch })) {
          rows.push([c, ch === null ? 'n/a' : ch, String(r.start), String(r.end), pyFloatRepr(r.start / sf), pyFloatRepr((r.end - r.start) / sf),
            r.p === null ? 'n/a' : pyFloatRepr(r.p), String(raters.length), String(r.n_marked), pyFloatRepr(r.weight_total), pyFloatRepr(r.weight_marked)].join('\t'));
        }
      };
      for (const c of cats) {
        block(c, null);
        if (byChannel) for (const ch of names) block(c, ch);
      }
      const base = rid.replace(/\//g, '__');
      const name = `${base.endsWith('.vhdr') ? base.slice(0, -5) : base.replace(/\./g, '_')}_probability.tsv`;
      files[name] = `${[COLUMNS.join('\t'), ...rows].join('\n')}\n`;
      listed[name] = { recording_id: rid, scope: 'study', sfreq: sf, n_samples: n, n_raters: raters.length, low_sample: raters.length === MIN_RATERS,
        categories: cats, channels: byChannel ? names : [], raters: raters.map((r) => ({ annotator_id: r.annotator_id, source: r.source, weight: r.weight })) };
    }
    const as = body.as;
    if (![undefined, null, 'zip', 'tsv'].includes(as)) throw bad('as is zip (the default) or tsv (one recording\'s map)');
    if (as === 'tsv' && (!Array.isArray(body.recording_ids) || body.recording_ids.length !== 1)) throw bad('as tsv gives one recording\'s map: name exactly one in recording_ids');
    if (as === 'tsv' && Object.keys(files).length) {
      const [name, text] = Object.entries(files)[0];
      const meta = listed[name];
      return { file_name: name, text, recordings: 1, left_out: [], low_sample: meta.low_sample ? [meta.recording_id] : [], raters: meta.raters, weights: weightsJson(weights) };
    }
    if (!Object.keys(files).length) {
      throw bad(`No recording has the ${least} raters a map needs${body.recording_ids ? ' among those named.' : '.'}`, 'no_maps', 404);
    }
    const settings = { made_at: nowLocalIso(), made_by: me, electrotag_version: 'demonstration', weights: weightsJson(weights), category, by_channel: byChannel,
      min_raters: least, columns: COLUMNS, recordings: listed, left_out_too_few_raters: tooFew };
    const zipped = zipBytes([{ name: 'probability/README.txt', text: 'Probability maps made by the ElectroTag demonstration (docs/reliability_guide.md, "Probability maps").\n' },
      { name: 'probability/probability.json', text: `${JSON.stringify(settings, null, 2)}\n` },
      ...Object.keys(files).sort(byCode).map((n2) => ({ name: `probability/${n2}`, text: files[n2] }))]);
    let bin = '';
    for (let i = 0; i < zipped.length; i += 0x8000) bin += String.fromCharCode(...zipped.subarray(i, i + 0x8000));
    return { file_name: 'probability_maps.zip', base64: btoa(bin), size_bytes: zipped.length, recordings: Object.keys(files).length, left_out: tooFew,
      low_sample: Object.values(listed).filter((r) => r.low_sample).map((r) => r.recording_id).sort(byCode) };
  }
}
