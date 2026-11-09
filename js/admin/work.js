// Giving out work (docs/admin_area.md, "Giving out work"): one page for the three ways recordings reach
// people, as tabs. Everything given out lists every recording each person has, however it was given (a
// task, a hand-out, the training programme or an assignment made by itself), with where it stands; the
// tabs Assignments, Hand-outs and Tasks are those sections (assignments.js, handouts.js, tasks.js), each
// under this page's heading and tabs (workHead).
//
// givenThrough and the summary are pure and tested in Node (web_tests/unit/ui_admin_work.test.mjs).

import { h, clear } from '../ui/dom.js';
import { MODES, SECTIONS, STATUS, plural, whenText } from './model.js';
import { card, chip, dataTable, docsLink, guideAnchor, messageArea, recordingName, select, textInput } from './ui.js';

/** The entry of the menu that shows a section (model.js SECTIONS): its page's, for a tab (`within`). */
export function menuKey(key) {
  const s = SECTIONS.find((x) => x.key === key);
  return (s && s.within) || key;
}

/** The page's tabs: [section key, title]. */
export const WORK_TABS = Object.freeze([
  ['work', 'Everything given out'], ['assignments', 'Assignments'], ['handouts', 'Hand-outs'], ['tasks', 'Tasks'],
]);

/** How a recording reached someone, in the words of the list's filter. */
export const THROUGH = Object.freeze({
  task: 'A task', handout: 'A hand-out', assignment: 'Assigned by itself', programme: 'The training programme',
});

/**
 * How an item of assignments_list was given (docs/api.md): {kind ('task', 'handout', 'assignment' or
 * 'programme'), text, detail, handoutId, taskId}, with the names of the hand-outs and tasks the study
 * lists (`handouts` by handout_id, `tasks` by task_id; either may be missing).
 */
export function givenThrough(item, { handouts = new Map(), tasks = new Map() } = {}) {
  const ho = item.handout_id ? handouts.get(item.handout_id) : null;
  const hoName = ho ? (ho.name || ho.title || '') : '';
  if (item.source === 'programme') return { kind: 'programme', text: 'Training programme', detail: '', handoutId: null, taskId: null };
  if (item.task_id) {
    const t = tasks.get(item.task_id);
    const detail = hoName ? `Shared out by the hand-out ${hoName}` : t && t.batch ? `Share-out: ${t.batch}` : '';
    return { kind: 'task', text: 'Task', detail, handoutId: item.handout_id || null, taskId: item.task_id };
  }
  if (item.handout_id) {
    const fromAssignments = ho && ho.target && ho.target.kind === 'recordings';
    // (one given in Assignments is named after its recordings: the title annotators see says which)
    return { kind: 'handout', text: 'Hand-out', detail: fromAssignments ? `${ho.title || hoName} (given in Assignments)` : hoName,
      handoutId: item.handout_id, taskId: null };
  }
  return { kind: 'assignment', text: 'Assigned by itself', detail: '', handoutId: null, taskId: null };
}

/** "120 given to 8 people, 35 done: 40 by tasks, 60 by hand-outs, 20 assigned by themselves." */
export function workSummary(rows) {
  if (!rows.length) return '';
  const by = { task: 0, handout: 0, assignment: 0, programme: 0 };
  for (const r of rows) by[r.through.kind] += 1;
  const people = new Set(rows.map((r) => r.annotator_id)).size;
  const done = rows.filter((r) => r.status === 'done').length;
  const parts = [by.task && `${by.task} by ${by.task === 1 ? 'a task' : 'tasks'}`, by.handout && `${by.handout} by ${by.handout === 1 ? 'a hand-out' : 'hand-outs'}`,
    by.assignment && `${by.assignment} assigned by ${by.assignment === 1 ? 'itself' : 'themselves'}`, by.programme && `${by.programme} in the training programme`].filter(Boolean);
  return `${rows.length} given to ${plural(people, 'person', 'people')}, ${done} done: ${parts.join(', ')}.`;
}

/** The heading of Giving out work, with its tabs, Help for the tab shown and the tab's introduction. */
export function workHead(current, intro = '') {
  const title = (WORK_TABS.find(([k]) => k === current) || WORK_TABS[0])[1];
  const anchor = current === 'work' ? guideAnchor('Giving out work') : guideAnchor(title);
  const help = docsLink('Help', 'admin_area.md', anchor, { title: `The guide to ${current === 'work' ? 'Giving out work' : title} (opens in a new tab)` });
  help.setAttribute('data-help', anchor);
  const tabs = h('nav.tabs.admin-tabs.work-tabs', { 'aria-label': 'Giving out work' }, WORK_TABS.map(([key, text]) => h('a.tab', {
    href: `#${key === 'work' ? 'admin-work' : `admin-${key}`}`, 'data-tab': key, 'aria-current': key === current ? 'page' : null,
  }, text)));
  return h('div.admin-head', {}, h('div.admin-head-row', {}, h('h1', { tabindex: '-1' }, 'Giving out work'), help), tabs,
    intro ? h('p.subtitle', {}, intro) : null);
}

export class WorkSection {
  constructor(area) {
    this.area = area;
    this.rows = [];
    this.msg = messageArea();
    this._buildTable();
    const ways = h('div.work-ways', {},
      this._way('assignments', 'Assignments', 'Give chosen recordings to chosen people, one by one, for annotation or for training. With a due date, they become a hand-out of their own.'),
      this._way('handouts', 'Hand-outs', 'Give a dataset or a collection to people and groups, with a due date and the title annotators see: all of it to everyone, or shared out as tasks.'),
      this._way('tasks', 'Tasks', 'Share recordings out so that several people annotate each one independently, for agreement and adjudication.'));
    this.el = h('section.admin-section', { 'data-section': 'work' },
      workHead('work', 'Everyone\'s recordings, however they were given, and the three ways to give more.'),
      this.msg, card('Three ways to give out work', ways), this.tableCard);
  }

  _way(key, title, text) {
    return h('div.work-way', {}, h('h3', {}, h('a', { href: `#admin-${key}`, 'data-log': `work-${key}` }, title)), h('p', {}, text));
  }

  async show() {
    this.msg.clear();
    await this.reload();
  }

  async reload() {
    let items;
    try {
      items = (await this.area.read('assignments_list')).items || [];
    } catch (exc) {
      this.msg.problem(exc);
      return;
    }
    // the names of hand-outs and tasks; without them (tasks need a study server or Firebase) the list still shows how
    const [ho, ts, us] = await Promise.all([this.area.read('handouts_list').catch(() => ({ handouts: [] })),
      this.area.read('tasks_list').catch(() => ({ tasks: [] })), this.area.read('users_list').catch(() => ({ users: [] }))]);
    const handouts = new Map((ho.handouts || []).map((x) => [x.handout_id, x]));
    const tasks = new Map((ts.tasks || []).map((x) => [x.task_id, x]));
    this.rows = items.map((i) => ({ ...i, through: givenThrough(i, { handouts, tasks }) }));
    this.tasks = tasks;
    const p = this.filters.person;
    const keep = p.value;
    clear(p);
    p.append(h('option', { value: '' }, 'Everyone'), ...(us.users || []).map((u) => h('option', { value: u.annotator_id }, u.annotator_id)));
    p.value = [...p.options].some((o) => o.value === keep) ? keep : '';
    this._filter();
  }

  _buildTable() {
    const person = select([['', 'Everyone']]);
    person.setAttribute('aria-label', 'Annotator');
    const through = select([['', 'Given in any way'], ...Object.entries(THROUGH)]);
    through.setAttribute('aria-label', 'Given through');
    const status = select([['', 'Every status'], ...Object.entries(STATUS)]);
    status.setAttribute('aria-label', 'Status');
    const search = textInput({ type: 'search', placeholder: 'Search recordings and hand-outs' });
    search.setAttribute('aria-label', 'Search everything given out');
    this.filters = { person, through, status, search };
    for (const f of Object.values(this.filters)) f.addEventListener('input', () => this._filter());
    this.table = dataTable([
      { title: 'Annotator', sort: (r) => r.annotator_id, render: (r) => h('b', {}, r.annotator_id) },
      { title: 'Recording', sort: (r) => r.recording_id, render: (r) => recordingName(r.recording_id) },
      { title: 'Given through', sort: (r) => r.through.text, render: (r) => this._through(r) },
      { title: 'Mode', sort: (r) => r.mode, render: (r) => (MODES[r.mode] || r.mode) + (r.context_id ? ` (${r.context_id})` : '') },
      { title: 'Status', sort: (r) => r.status, render: (r) => chip(STATUS[r.status] || r.status, r.status === 'done' ? 'done' : r.status === 'in_progress' ? 'active' : '') },
      { title: 'Last activity', sort: (r) => r.last_activity || '', render: (r) => whenText(r.last_activity, { never: '–' }) },
    ], [], { empty: 'Nothing is given out yet. Use Assignments, Hand-outs or Tasks to give people recordings.', pageSize: 50,
      caption: 'Everything given out', sortable: true, rowKey: (r) => `${r.annotator_id} ${r.mode} ${r.context_id} ${r.recording_id}` });
    this.summary = h('p.caption', { role: 'status' });
    this.tableCard = card('Everything given out', h('div.row.filters', {}, person, through, status, search), this.summary, this.table);
  }

  _through(r) {
    const t = r.through;
    let detail = t.detail ? h('span.caption.block', {}, t.detail) : null;
    if (t.kind === 'handout' && t.handoutId) {
      detail = h('button.link.caption.block', { type: 'button', 'data-log': 'work-open-handout', onclick: () => this.area.go('handouts', { handout: t.handoutId }) },
        t.detail || 'Open the hand-out');
    } else if (t.kind === 'task') {
      const task = this.tasks && this.tasks.get(t.taskId);
      detail = h('button.link.caption.block', { type: 'button', 'data-log': 'work-open-task',
        onclick: () => this.area.go('tasks', { search: (task && task.file_name) || r.recording_id }) }, t.detail || 'See the task');
    }
    return h('span', {}, t.text, detail);
  }

  _filter() {
    const { person, through, status, search } = this.filters;
    const q = search.value.trim().toLowerCase();
    const rows = this.rows.filter((r) => (!person.value || r.annotator_id === person.value) && (!through.value || r.through.kind === through.value)
      && (!status.value || r.status === status.value)
      && (!q || `${r.recording_id} ${r.through.detail}`.toLowerCase().includes(q)));
    this.summary.textContent = workSummary(rows);
    this.table.update(rows, { keepPage: true });
  }
}
