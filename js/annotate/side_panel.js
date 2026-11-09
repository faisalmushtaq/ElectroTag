// The side panel's width (docs/using.md, "The annotation view"): its edge, between the EEG and the panel, is
// dragged to widen or narrow it (or moved with the arrow keys; a double click goes back to the usual width),
// and its button hides the panel to give the EEG the whole window, or brings it back. Both are remembered in
// this browser for each person, as the other display choices are. A panel made wide enough sets its parts
// side by side (app.css, .ws-side.wide): the topographic map and the coach on the left, the tabs on the
// right with the panel's whole height. The coach's instructions and a review pass bring a hidden panel back.
//
// clampSideWidth is pure and tested in Node (web_tests/unit/ui_side_panel.test.mjs).

import { h } from '../ui/dom.js';
import { icon } from '../views/common.js';
import { local } from '../util.js';
import { logger } from '../log/logger.js';

/** The narrowest the panel is made, in pixels. */
export const SIDE_MIN = 280;
/** The EEG keeps at least this width beside the panel. */
export const EEG_MIN = 480;
/** From this width the panel sets its parts side by side. */
export const WIDE_AT = 600;
/** One press of an arrow key moves the edge this far. */
export const STEP = 20;

/** The width to give the panel when `want` pixels are asked for in an area `mainWidth` pixels across. */
export function clampSideWidth(want, mainWidth) {
  const max = Math.max(SIDE_MIN, Math.floor(mainWidth) - EEG_MIN);
  const w = typeof want === 'number' && !Number.isNaN(want) ? want : SIDE_MIN;
  return Math.round(Math.min(max, Math.max(SIDE_MIN, w)));
}

/**
 * The edge of the side panel of a workspace `ws` (js/annotate/workspace.js): its view (`ws.el`), the area
 * holding the EEG and the panel (`ws.main`), the panel (`ws.side`) and the key for a person's display
 * choices (`ws._toolKey`). Returns the edge, already placed before the panel, and a function that takes
 * it down.
 */
export function mountSideEdge(ws) {
  const widthKey = ws._toolKey('side_width');
  const hiddenKey = ws._toolKey('side_hidden');
  const view = ws.el;
  const toggle = h('button.btn.icon.small.quiet.ws-side-toggle', { type: 'button', 'data-log': 'side-panel-toggle' });
  const grip = h('div.ws-side-grip', {
    role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Width of the side panel',
    'aria-controls': 'ws-side', 'data-log': 'side-panel-width',
    title: 'Drag to widen or narrow the side panel (or use the arrow keys); double-click for the usual width',
  });
  ws.side.id = 'ws-side';
  const edge = h('div.ws-side-edge', {}, toggle, grip);
  ws.main.insertBefore(edge, ws.side);

  const current = () => Math.round(ws.side.getBoundingClientRect().width);
  const sayWidth = () => {
    const w = current();
    grip.setAttribute('aria-valuenow', String(w));
    grip.setAttribute('aria-valuemin', String(SIDE_MIN));
    grip.setAttribute('aria-valuemax', String(clampSideWidth(Infinity, ws.main.clientWidth)));
    grip.setAttribute('aria-valuetext', `${w} pixels`);
  };
  const apply = (w) => {
    // (before the view is on screen its width is not known: app.css keeps the panel within the window)
    const across = ws.main.clientWidth;
    if (w == null) view.style.removeProperty('--side-w');
    else view.style.setProperty('--side-w', `${across ? clampSideWidth(w, across) : Math.max(SIDE_MIN, Math.round(w))}px`);
  };
  const logState = (via) => logger.event('state', { side_panel: { width_px: current(), hidden: view.classList.contains('side-hidden') }, via });

  const setHidden = (hidden, via = null) => {
    view.classList.toggle('side-hidden', hidden);
    if (hidden) ws.side.classList.remove('wide');
    clearChildren(toggle);
    toggle.append(icon(hidden ? 'chevron-left' : 'chevron-right'));
    const label = hidden ? 'Show the side panel' : 'Hide the side panel, giving the EEG the whole width';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    toggle.setAttribute('aria-expanded', String(!hidden));
    toggle.setAttribute('aria-controls', 'ws-side');
    grip.hidden = hidden;
    if (via) {
      local.set(hiddenKey, hidden);
      logState(via);
    }
  };
  toggle.addEventListener('mousedown', (e) => e.preventDefault()); // the keyboard focus stays with the EEG
  toggle.addEventListener('click', () => setHidden(!view.classList.contains('side-hidden'), 'button'));

  // dragging the edge
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, right: ws.main.getBoundingClientRect().right, startW: current() };
    view.classList.add('side-resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    apply(drag.right - e.clientX - grip.getBoundingClientRect().width / 2);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = current() !== drag.startW;
    drag = null;
    view.classList.remove('side-resizing');
    if (moved) { local.set(widthKey, current()); logState('drag'); }
    sayWidth();
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('dblclick', () => { local.remove(widthKey); apply(null); logState('reset'); });
  grip.addEventListener('keydown', (e) => {
    const by = { ArrowLeft: STEP, ArrowRight: -STEP, PageUp: 5 * STEP, PageDown: -5 * STEP }[e.key];
    let w;
    if (by) w = current() + by;
    else if (e.key === 'Home') w = SIDE_MIN;
    else if (e.key === 'End') w = Infinity;
    else return;
    e.preventDefault();
    e.stopPropagation(); // the arrow keys also move through the recording
    apply(w);
    local.set(widthKey, current());
    sayWidth();
    logState('key');
  });

  // wide enough: the parts side by side
  const ro = new ResizeObserver(() => {
    // (below the EEG, on an iPad held upright, the panel already sets its parts side by side)
    const below = getComputedStyle(ws.side).flexDirection === 'row';
    ws.side.classList.toggle('wide', !below && !view.classList.contains('side-hidden') && ws.side.getBoundingClientRect().width >= WIDE_AT);
    sayWidth();
  });
  ro.observe(ws.side);

  // The coach's instructions and a review pass are read in the panel: they bring a hidden panel back.
  const needed = () => [...ws.side.children].some((c) => (c.classList.contains('coach-host') || c.classList.contains('review-host'))
    && c.childElementCount > 0);
  const mo = new MutationObserver(() => { if (view.classList.contains('side-hidden') && needed()) setHidden(false); });
  mo.observe(ws.side, { childList: true, subtree: true });

  const kept = Number(local.get(widthKey, null));
  if (kept > 0) apply(kept);
  setHidden(local.get(hiddenKey, false) === true && !needed());
  return { edge, destroy: () => { ro.disconnect(); mo.disconnect(); }, setHidden };
}

function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }
