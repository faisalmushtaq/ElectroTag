// The study's hidden artifact types (annotation.hidden_labels; docs/admin_area.md, Study settings): left out of
// every list a type is chosen from (the type buttons and number keys, Find a type, Change type and the menus),
// while every type stays known, so that a mark that already has a hidden type shows and keeps it. The uncertain
// type is never hidden. Loaded with the annotation session, so that the sign-in page never needs it.

import { UNCERTAIN_LABEL } from '../catalogue.js';

/** The catalogue `cat` with `names` left out of its lists (sections, specificLabels, quickLabels). */
export function withHiddenTypes(cat, names) {
  const hidden = new Set((names || []).filter((n) => cat.has(n) && n !== UNCERTAIN_LABEL));
  if (!hidden.size) return cat;
  const c = Object.create(cat);
  c.hidden = hidden;
  c.sections = () => cat.sections().map((s) => ({ ...s, labels: s.labels.filter((l) => !hidden.has(l.label)) })).filter((s) => s.labels.length);
  c.specificLabels = () => cat.specificLabels().filter((n) => !hidden.has(n));
  // (the catalogue's own rule, with this specificLabels for its fallback)
  c.quickLabels = (chosen) => Object.getPrototypeOf(cat).quickLabels.call(c, (chosen || []).filter((n) => !hidden.has(n)));
  return c;
}
