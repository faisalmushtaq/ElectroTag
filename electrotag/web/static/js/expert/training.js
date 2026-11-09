// Training sets in the expert area (docs/admin_area.md, "The expert area"): the admin area's Training section
// (js/admin/training.js), for the study's experts to set up reference sets as administrators do. Its calls are
// the admin area's operations that experts may use (electrotag/web/admin.py EXPERT_OPERATIONS), audited under
// the expert's ID; registering recordings stays with the administrators.

import { TrainingSection } from '../admin/training.js';

/** What the Training section asks of the admin area, from the expert area: its reads kept until a change. */
function trainingArea(area) {
  const reads = new Map();
  return {
    app: area.app,
    backend: area.backend,
    forExperts: true,
    get labels() { return (area.app.me && area.app.me.catalogue && area.app.me.catalogue.labels) || []; },
    get catalogue() { return area.app.catalogue; },
    read(op, body = {}) {
      const key = `${op} ${JSON.stringify(body)}`;
      if (!reads.has(key)) {
        const p = area.backend.admin(op, body);
        reads.set(key, p);
        p.catch(() => reads.delete(key));
      }
      return reads.get(key);
    },
    async write(op, body = {}) {
      try { return await area.backend.admin(op, body); } finally { reads.clear(); }
    },
    clearReads() { reads.clear(); },
  };
}

export class ExpertTrainingSection extends TrainingSection {
  constructor(area) {
    super(trainingArea(area));
  }

  async show(params) {
    this.area.clearReads();
    return super.show(params || {});
  }
}
