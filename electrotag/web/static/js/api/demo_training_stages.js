// The training path's operations in the sandbox (docs/api.md, "Training stages"), as
// electrotag/web/training_path.py does them on a server: skipping, finishing and resuming stages
// (POST /training/stage), the artifact snippets (GET /training/snippets), the study team's own snippets
// and a trainee's path in the admin area. Loaded at the first use of any of them (js/lazy.js, part
// demoTraining), so the sandbox's sign-in page does not carry it. The stages themselves are worked out
// by js/training/stages.js, which the sandbox's back end (demo.js) uses at every call.
//
// The sandbox's training set has no assessment (its result needs ElectroTag's Python code), so the
// competency gate is always open here, and reopening a trainee's training or giving them a new
// assessment set is refused as a study server refuses it before an assessment is finished.

import { ApiError } from './http.js';
import { CATALOGUE } from './demo_catalogue.js';
import { DONE_IN_BROWSER, STAGES, STAGE_TITLES, maySkip, stageMarks } from '../training/stages.js';
import { nowLocalIso } from '../util.js';

/** artifact_texts.py TEXT_FIELDS, and those of the guide (with the look-alikes). */
const TEXT_NAMES = ['description', 'where', 'frequency', 'shape', 'duration'];
const GUIDE_TEXT_FIELDS = ['where', 'frequency', 'shape', 'duration', 'apart'];

const SNIPPET_MAX_S = 60;
const SNIPPET_MAX_CONTEXT_S = 10;
const MAX_EXPLANATION = 1000;
const NO_SNIPPETS_FROM = ['practice', 'assessment'];
const SNIPPET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REOPEN_FROM = ['guided', 'practice'];
const bad = (message, code = 'bad_request', status = 400) => new ApiError(status, code, message);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export class DemoTrainingStages {
  /** @param backend the DemoBackend whose state and accounts this works on */
  constructor(backend) {
    this.b = backend;
    // The admin operations of the training path, on the sandbox's admin area (demo_admin.js runs op_<name>).
    const admin = backend._admin;
    for (const op of ['snippets_list', 'snippet_add', 'snippet_remove']) admin[`op_${op}`] = (body) => this[op](body, admin.b.annotatorId);
    admin.op_training_gate_get = (body) => this.gateGet(body);
    admin.op_training_reopen = (body) => this.reopen(body);
    admin.op_training_assessment_set = (body) => this.assessmentSet(body);
    admin.op_artifact_texts_list = () => this.textsList();
    admin.op_artifact_text_set = (body) => this.textSet(body);
  }

  // ------------------------------------------------------------ the study's own words for its artifact types
  /** The kept changes (artifact_texts.py): label -> {label, fields, changed_at, changed_by}, kept with the admin area's state. */
  get _texts() { return this.b._admin.s.artifact_texts || (this.b._admin.s.artifact_texts = {}); }

  /** GET /me's catalogue with the study's words (artifact_texts.py apply). */
  catalogue() {
    const texts = this._texts;
    return { labels: CATALOGUE.labels.map((l) => {
      const f = (texts[l.label] || {}).fields;
      if (!f || !Object.keys(f).length) return l;
      const guide = Object.fromEntries(GUIDE_TEXT_FIELDS.filter((k) => k in f).map((k) => [k, f[k]]));
      return { ...l, ...(typeof f.description === 'string' ? { description: f.description } : {}), ...(Object.keys(guide).length ? { guide } : {}) };
    }) };
  }

  /** artifact_texts_list. */
  textsList() {
    const texts = {};
    for (const [label, r] of Object.entries(this._texts)) {
      if (r.fields && Object.keys(r.fields).length) texts[label] = { fields: r.fields, changed_at: r.changed_at || null, changed_by: r.changed_by || null };
    }
    return { texts, original: Object.fromEntries(CATALOGUE.labels.map((l) => [l.label, l.description])) };
  }

  /** artifact_text_set (artifact_texts.py set). */
  textSet(body) {
    const known = (x) => typeof x === 'string' && CATALOGUE.labels.some((l) => l.label === x);
    const { label, fields } = body || {};
    if (!known(label)) throw bad("label must be one of the study's artifact types");
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) {
      throw bad('fields must name at least one of description, where, frequency, shape, duration or apart');
    }
    const clean = {};
    for (const [name, value] of Object.entries(fields)) {
      if (TEXT_NAMES.includes(name)) {
        if (value !== null && (typeof value !== 'string' || value.length > 2000)) throw bad(`${name} must be text of at most 2000 characters, or null for the original`);
        clean[name] = typeof value === 'string' ? value.trim() : null;
        if (name === 'description' && clean[name] === '') throw bad("The description cannot be empty: write the study's own words, or set it back to the original");
      } else if (name === 'apart') {
        let v = value;
        if (v !== null) {
          if (!Array.isArray(v) || v.length > 12) throw bad('apart must be a list of at most 12 look-alikes, or null for the original');
          v = v.map((row) => {
            if (!Array.isArray(row) || row.length !== 2 || !known(row[0]) || typeof row[1] !== 'string' || !row[1].trim() || row[1].length > 2000) {
              throw bad('each look-alike is [an artifact type of the study, how to tell them apart]');
            }
            return [row[0], row[1].trim()];
          });
        }
        clean[name] = v;
      } else {
        throw bad(`${name} is not a text of an artifact type: description, where, frequency, shape, duration or apart`);
      }
    }
    const kept = { ...((this._texts[label] || {}).fields || {}) };
    const changed = [];
    for (const [name, value] of Object.entries(clean)) {
      if (value === null) { if (name in kept) { delete kept[name]; changed.push(name); } } else if (JSON.stringify(kept[name]) !== JSON.stringify(value)) { kept[name] = value; changed.push(name); }
    }
    if (changed.length) {
      this._texts[label] = { label, fields: kept, changed_at: nowLocalIso(), changed_by: this.b.annotatorId };
      this.b._save();
      const back = changed.filter((n) => clean[n] === null);
      const words = changed.filter((n) => !back.includes(n));
      this.b._admin._audit('artifact_text_set', `Changed the texts of ${label}: ${[words.length ? `${words.join(', ')} in the study's own words` : '', back.length ? `${back.join(', ')} back to the original` : ''].filter(Boolean).join(', ')}`,
        { label, changed, original: back, fields: Object.fromEntries(words.map((n) => [n, clean[n]])) });
    }
    const r = this._texts[label];
    return { label, text: r && Object.keys(r.fields || {}).length ? { fields: r.fields, changed_at: r.changed_at, changed_by: r.changed_by } : null };
  }

  get set() { return this.b._exampleSet(); }

  // ------------------------------------------------------------ stage actions
  /** POST /training/stage (training_path.py stage_action): the same request twice changes nothing more. */
  /** GET /me's tour (training_path.py welcome_tour): offered once to someone outside the programme, unless the study has it off. */
  tourOf(aid) {
    if (this.b._inProgramme(aid) || !this.b._policy().tour) return null;
    return (this.b.state.tours || {})[aid] || 'todo';
  }

  stageAction(body) {
    const aid = this.b._aid();
    const { stage, action } = body || {};
    if (!STAGES.includes(stage) || !['skip', 'done', 'resume'].includes(action)) {
      throw bad('stage must be one of tour, snippets, guided, practice or assessment, and action one of skip, done or resume');
    }
    if (stage === 'assessment' && action === 'skip') {
      throw new ApiError(409, 'cannot_skip', 'The competency assessment cannot be skipped: it is passed before real study work begins.');
    }
    if (!this.b._inProgramme(aid)) {
      // outside a programme only the tour has a stage (training_path.py _tour_action): kept for the account
      if (stage !== 'tour') throw new ApiError(404, 'no_programme', 'You are not taking part in a training programme');
      const tours = this.b.state.tours || (this.b.state.tours = {});
      const want = { done: 'done', skip: 'skipped', resume: 'todo' }[action];
      if (!(tours[aid] === 'done' && want === 'skipped')) tours[aid] = want;
      this.b._save();
      return { tour: this.tourOf(aid) };
    }
    const policy = this.b._policy();
    const st = this.b._stages(aid).find((s) => s.key === stage);
    const title = STAGE_TITLES[stage];
    const note = (event, fields = {}) => {
      this.b._progress(aid).events.push({ event, at: nowLocalIso(), stage, ...fields });
      this.b._save();
    };
    const view = () => this.b._trainingView(aid);
    if (action === 'skip') {
      if (st.status === 'skipped') return view();
      if (!maySkip(policy, stage)) throw new ApiError(409, 'cannot_skip', `This study asks every trainee to do ${title}, so it cannot be skipped.`);
      if (stageMarks(this.b._progress(aid).events).reopenedStage(stage) && ['available', 'in_progress'].includes(st.status)) {
        throw new ApiError(409, 'reopened', `Your study team reopened your training so that you do ${title} again before the assessment, so it cannot be skipped this time.`);
      }
      if (st.status === 'locked') throw new ApiError(409, 'locked', `${title} is not open yet: finish or skip the stage before it first.`);
      if (st.status === 'completed' || st.status === 'not_used') {
        throw new ApiError(409, 'finished', `${title} is ${st.status === 'completed' ? 'done already' : 'not part of your training'}, so there is nothing to skip.`);
      }
      note('stage_skipped', { policy: [...policy.skippable] });
    } else if (action === 'resume') {
      if (st.status !== 'skipped') return view();
      note('stage_resumed');
    } else {
      if (!DONE_IN_BROWSER.includes(stage)) throw new ApiError(409, 'not_done_here', `${title} is finished by saving its recordings.`);
      if (st.status === 'completed') return view();
      if (st.status === 'locked') throw new ApiError(409, 'locked', `${title} is not open yet: finish or skip the stage before it first.`);
      if (st.status === 'not_used') throw new ApiError(409, 'finished', `${title} is not part of your training.`);
      if (stage === 'snippets' && policy.snippets_quiz_required) {
        const quiz = this._quiz(aid);
        if (quiz && !quiz.finished) {
          throw new ApiError(409, 'quiz_required', `Finish the recognition check first: this study counts ${title} as done once its check is finished.`);
        }
      }
      note('stage_completed');
    }
    return view();
  }

  // ----------------------------------------------------------------- snippets
  _quiz(aid) {
    const items = this.b._quizItemsOf(this.set.set_id);
    // a quiz on a practice or assessment recording would give its answers away (training_path.py _quiz)
    if (!items.length || !this.b._quizAllowed(aid) || items.some((it) => NO_SNIPPETS_FROM.includes(this._use(it.recording_id)))) return null;
    const st = this.b._quizState(aid, false);
    const finished = Boolean(st.finished);
    const n = finished && st.score ? st.score.n_correct : null;
    return { n_items: items.length, finished, required: this.b._policy().snippets_quiz_required, n_correct: Number.isFinite(n) ? n : null };
  }

  _use(rid) { return ((this.set.recordings || []).find((r) => r.recording_id === rid) || {}).use || ''; }

  /** One snippet for each reference annotation of a guided recording (reference.py guided_snippets). */
  _guidedSnippets() {
    const out = [];
    for (const r of (this.set.recordings || []).filter((x) => x.use === 'guided')) {
      const info = this.b._recordingInfo(r.recording_id);
      if (!info) continue;
      const truth = [...this.b._truthOf(r.recording_id)]
        .sort((a, c) => a.onset_sample - c.onset_sample || (a.annotation_id < c.annotation_id ? -1 : a.annotation_id > c.annotation_id ? 1 : 0));
      for (const a of truth) {
        out.push({ snippet_id: `g-${a.annotation_id}`, recording_id: r.recording_id, start_s: a.onset_sample / info.sfreq,
          end_s: (a.onset_sample + a.duration_samples) / info.sfreq, label: a.label,
          explanation: this.b._admin.guidedNote(this.set.set_id, a.annotation_id) ?? this.b._exampleNoteOf(r.recording_id, a),
          context_s: 2.0, channels: [...(a.channels || [])], source: { kind: 'guided', annotation_id: a.annotation_id } });
      }
    }
    return out;
  }

  _own() { return (this.set.snippets || []).filter((x) => !NO_SNIPPETS_FROM.includes(this._use(x.recording_id))); }

  /** GET /training/snippets (training_path.py snippets_view). */
  async snippetsView() {
    const aid = this.b._aid();
    if (!this.b._inProgramme(aid)) throw new ApiError(404, 'no_programme', 'You are not taking part in a training programme');
    const snippets = [...this._own(), ...this._guidedSnippets()].filter((s) => this.b._recordingInfo(s.recording_id));
    const recordings = {};
    for (const s of snippets) if (!recordings[s.recording_id]) recordings[s.recording_id] = await this.b._publicManifest(s.recording_id);
    return JSON.parse(JSON.stringify({ set_id: this.set.set_id, snippets, recordings, quiz: this._quiz(aid) }));
  }

  /** snippets_list (admin and expert): the study team's snippets, those of the guided references, and the recordings a snippet may come from. */
  snippets_list(body) {
    const set = this.b._admin._setOr404(body.set_id);
    const recordings = [];
    for (const r of set.recordings || []) {
      const info = this.b._recordingInfo(r.recording_id);
      if (NO_SNIPPETS_FROM.includes(r.use) || !info) continue;
      recordings.push({ recording_id: r.recording_id, file_name: info.file_name, use: r.use, duration_s: info.n_samples / info.sfreq, ch_names: [...info.ch_names] });
    }
    return { set_id: set.set_id, snippets: JSON.parse(JSON.stringify(set.snippets || [])), guided: this._guidedSnippets(), recordings };
  }

  /** snippet_add (training_path.py snippet_add): the same snippet_id again replaces it. */
  snippet_add(body, by) {
    const set = this.b._admin._setOr404(body.set_id);
    const rid = body.recording_id;
    if (typeof rid !== 'string' || !rid) throw bad('recording_id is missing');
    const use = this._use(rid);
    if (NO_SNIPPETS_FROM.includes(use)) {
      throw bad(`${rid} is ${/^[aeiou]/i.test(use) ? 'an' : 'a'} ${use} recording of this set: a snippet of it would show trainees the answers they are scored against. Choose a guided recording, or another recording that no set uses for practice or assessment.`, 'reveals_answers', 422);
    }
    const info = (set.recordings || []).some((r) => r.recording_id === rid) ? this.b._recordingInfo(rid) : null;
    if (!info) throw new ApiError(404, 'unknown_recording', `${rid} is not a recording of the reference set ${set.set_id}`);
    const duration = info.n_samples / info.sfreq;
    const number = (key, lo, hi, dflt) => {
      const v = body[key] === undefined || body[key] === null ? dflt : body[key];
      if (!finite(v) || v < lo || v > hi) throw bad(`${key} must be a number of seconds from ${lo} to ${hi}`);
      return v;
    };
    const start = number('start_s', 0, duration);
    const end = number('end_s', 0, duration);
    if (end <= start) throw bad('end_s must be after start_s');
    if (end - start > SNIPPET_MAX_S) throw bad(`A snippet is at most ${SNIPPET_MAX_S} s long`);
    const context = number('context_s', 0, SNIPPET_MAX_CONTEXT_S, 2.0);
    if (typeof body.label !== 'string' || !CATALOGUE.labels.some((l) => l.label === body.label)) throw bad("label must be one of the study's artifact types");
    const explanation = body.explanation ?? '';
    if (typeof explanation !== 'string' || explanation.length > MAX_EXPLANATION) throw bad(`explanation must be text of at most ${MAX_EXPLANATION} characters`);
    const channels = body.channels ?? [];
    if (!Array.isArray(channels) || !channels.every((c) => typeof c === 'string' && info.ch_names.includes(c)) || new Set(channels).size !== channels.length) {
      throw bad('channels must be a list of the recording\'s channel names, each once (none: the whole montage)');
    }
    const sid = body.snippet_id;
    if (sid !== undefined && sid !== null && (typeof sid !== 'string' || !SNIPPET_ID_RE.test(sid) || sid.startsWith('g-'))) {
      throw bad('snippet_id is 1 to 64 letters, digits, dots, hyphens or underscores (not starting with g-)');
    }
    const kept = set.snippets || (set.snippets = []);
    // the same artifact twice would show trainees the same example twice (training_path.py snippet_add)
    const twin = kept.find((x) => x.snippet_id !== sid && x.recording_id === rid && Math.abs(x.start_s - start) < 0.0015 && Math.abs(x.end_s - end) < 0.0015 && x.label === body.label);
    if (twin) throw new ApiError(409, 'duplicate', `The set already has this snippet (${twin.snippet_id}: ${body.label}, ${start.toFixed(2)}–${end.toFixed(2)} s of ${rid}).`);
    let id = sid;
    if (!id) {
      let n = 1;
      while (kept.some((x) => x.snippet_id === `s${String(n).padStart(2, '0')}`)) n += 1;
      id = `s${String(n).padStart(2, '0')}`;
    }
    const src = body.source && typeof body.source === 'object' ? body.source : { kind: 'added' };
    const source = { ...Object.fromEntries(Object.entries(src).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))), by: by || this.b._aid() };
    const snippet = { snippet_id: id, recording_id: rid, start_s: start, end_s: end, label: body.label, explanation: explanation.trim(),
      context_s: context, channels: [...channels], source };
    set.snippets = [...kept.filter((x) => x.snippet_id !== id), snippet];
    this.b._admin._audit('snippet_add', `Added the snippet ${id} (${body.label}, ${start.toFixed(2)}–${end.toFixed(2)} s of ${rid}) to ${set.set_id}`,
      { set_id: set.set_id, snippet_id: id, recording_id: rid, label: body.label, start_s: start, end_s: end, explanation_length: explanation.trim().length });
    this.b._save();
    return { snippet: JSON.parse(JSON.stringify(snippet)) };
  }

  snippet_remove(body) {
    const set = this.b._admin._setOr404(body.set_id);
    const sid = body.snippet_id;
    if (typeof sid !== 'string' || !sid) throw bad('snippet_id is missing');
    if (sid.startsWith('g-')) {
      throw new ApiError(409, 'guided_snippet', 'This snippet is made from a reference annotation of a guided recording, so it stays while that recording is guided.');
    }
    if (!(set.snippets || []).some((x) => x.snippet_id === sid)) return {};
    set.snippets = set.snippets.filter((x) => x.snippet_id !== sid);
    this.b._admin._audit('snippet_remove', `Removed the snippet ${sid} from ${set.set_id}`, { set_id: set.set_id, snippet_id: sid });
    this.b._save();
    return {};
  }

  // ------------------------------------------- a trainee's path in the admin area
  _who(body) {
    const aid = typeof body.annotator_id === 'string' ? body.annotator_id.trim().toUpperCase() : '';
    if (!aid) throw bad('annotator_id is missing');
    this.b._admin._userOr404(aid);
    return aid;
  }

  /** training_gate_get (training_path.py admin_gate_get). */
  gateGet(body) {
    const aid = this._who(body);
    const out = { annotator_id: aid, training_gate: this.b._gate(), programme: null, events: [], skipped: [], rounds: [], can_reopen: false,
      can_assign_set: false, assessment_sets: [] };
    if (!this.b._inProgramme(aid)) return out;
    const events = this.b._progress(aid).events;
    out.programme = this.b._trainingView(aid);
    out.events = events.map((e) => Object.fromEntries(['event', 'stage', 'at', 'by', 'from', 'from_set', 'set_name'].filter((k) => k in e).map((k) => [k, e[k]])));
    out.skipped = stageMarks(events).skipped;
    return out;
  }

  _trainee(body) {
    const aid = this._who(body);
    if (!this.b._inProgramme(aid)) throw new ApiError(404, 'no_programme', `${aid} is not taking part in a training programme`);
    return aid;
  }

  _notFinished(aid) {
    return new ApiError(409, 'not_finished', `${aid} has not finished the competency assessment of ${this.set.set_id} yet; this is for after an assessment that did not meet the criteria.`);
  }

  /** training_reopen: refused, as before any assessment is finished (the sandbox's set has none). */
  reopen(body) {
    const aid = this._trainee(body);
    if (!REOPEN_FROM.includes(body.from || 'practice')) throw bad('from must be practice or guided: the stage the trainee starts again from');
    throw this._notFinished(aid);
  }

  /** training_assessment_set: the sandbox has no other set, and its own has no assessment. */
  assessmentSet(body) {
    const aid = this._trainee(body);
    const set = this.b._admin._setOr404(body.set_id);
    if (set.set_id === this.set.set_id) {
      throw new ApiError(409, 'same_set', `${aid} already takes ${set.set_id}; to let them try its assessment again, reopen their training instead.`);
    }
    throw new ApiError(422, 'no_assessment', `${set.set_id} has no assessment recordings to take.`);
  }
}

/** The snippets in the expert channel (demo_expert.js PARTS): experts supply training material too. */
export const SNIPPET_EXPERT_OPS = {
  async snippets_list(x, body) { return (await x.b._trainingPart()).snippets_list(body); },
  async snippet_add(x, body) { return (await x.b._trainingPart()).snippet_add(body, x.b._aid()); },
  async snippet_remove(x, body) { return (await x.b._trainingPart()).snippet_remove(body); },
};
