// Plan: the base-route workbench — optimize (straight/road), generate load-order groups,
// save as official, and review load-order conflicts. Mirrors the Android Plan screen.

import * as db from './db.js';
import { optimizeStraightLine, optimizeByRoad } from './geo.js';
import { enforceLoadOrder, generateLoadOrder, loadOrderNum } from './logic.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let planOrder = null;      // working order (stop ids) while on this tab
let flags = [];            // load-order conflict strings from the last optimize

export function renderPlan(root, ctx) {
  const { pid, toast, rerender } = ctx;
  const stops = db.getStops(pid);
  const byId = new Map(stops.map((s) => [s.id, s]));

  // Working order: previous session on this tab → official → load-order sort.
  let order;
  if (planOrder && planOrder.every((id) => byId.has(id)) && planOrder.length === stops.length) {
    order = planOrder.map((id) => byId.get(id));
  } else {
    const official = db.getOfficial(pid);
    const rank = new Map((official || []).map((id, i) => [id, i]));
    order = stops.slice().sort((a, b) =>
      ((a.anchor === 'start' ? 0 : a.anchor === 'finish' ? 2 : 1) -
       (b.anchor === 'start' ? 0 : b.anchor === 'finish' ? 2 : 1)) ||
      ((rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity)) ||
      (loadOrderNum(a) - loadOrderNum(b)));
    planOrder = order.map((s) => s.id);
  }

  root.innerHTML = `
    <header class="bar"><h1>Plan</h1><span class="bar-note">${stops.length} stops</span></header>
    <div class="btnrow pad wrap">
      <button class="btn outline" id="opt-line">⚡ Optimize (straight)</button>
      <button class="btn outline" id="opt-road">🛣️ Optimize by road</button>
      <button class="btn outline" id="gen-load">🔢 Generate load order</button>
      <button class="btn primary" id="save-official">💾 Save as official</button>
    </div>
    <p id="status" class="muted pad"></p>
    <div id="conflicts"></div>
    <ul class="list" id="rows"></ul>`;

  const status = root.querySelector('#status');

  function apply(newOrder, note) {
    const { order: fixed, violations } = enforceLoadOrder(newOrder);
    flags = violations.map((vio) =>
      `${vio.stop.address} (load ${vio.stop.loadOrder}) — route wants it before group ${vio.conflictsWithGroup}; held back.`);
    planOrder = fixed.map((s) => s.id);
    status.textContent = flags.length ? `${note} — ${flags.length} stop(s) held back by load order.` : note;
    rerender();
  }

  root.querySelector('#opt-line').addEventListener('click', () =>
    apply(optimizeStraightLine(order), 'Optimized (straight-line).'));

  root.querySelector('#opt-road').addEventListener('click', async () => {
    status.textContent = 'Optimizing by road…';
    try {
      const res = await optimizeByRoad(order);
      if (res.polyline?.length) db.setRoadPolyline(pid, res.polyline);
      apply(res.order, 'Optimized by road (polyline saved for daily package slotting).');
    } catch (e) { status.textContent = `Road optimize failed: ${e.message}`; }
  });

  root.querySelector('#gen-load').addEventListener('click', () => {
    const size = db.getGroupSize();
    const assignments = generateLoadOrder(order.filter((s) => s.routeStop), size);
    const all = db.getStops(pid).map((s) => assignments[s.id] ? { ...s, loadOrder: assignments[s.id] } : s);
    db.setStops(pid, all);
    flags = [];
    const n = Object.keys(assignments).length;
    toast(`Load order generated — ${n} stops in groups of ${size}.`);
    rerender();
  });

  root.querySelector('#save-official').addEventListener('click', () => {
    db.setOfficial(pid, order.filter((s) => s.routeStop || s.anchor).map((s) => s.id));
    toast('Saved as official route.');
  });

  const conflicts = root.querySelector('#conflicts');
  conflicts.innerHTML = flags.length ? `
    <div class="card warn">
      <strong>⚠ Load-order conflicts (${flags.length})</strong>
      ${flags.slice(0, 4).map((f) => `<p>${esc(f)}</p>`).join('')}
      ${flags.length > 4 ? `<p>…and ${flags.length - 4} more</p>` : ''}
      <p class="muted">Either re-generate the load order to match this route, or fix the stop's data.</p>
    </div>` : '';

  // ── Ordered list with simple ▲▼ nudges ────────────────────────────────────
  const rows = root.querySelector('#rows');
  rows.innerHTML = order.map((s, i) => `
    <li class="row">
      <span class="num">${i + 1}</span>
      <span class="rowtext"><strong>${esc(s.address)}</strong>
        <small>${[s.anchor ? `⚑ ${esc(s.anchor)}` : null, s.routeStop ? 'box stop' : null,
                  s.loadOrder ? `Load ${esc(s.loadOrder)}` : null].filter(Boolean).join(' · ')}</small></span>
      <button class="rowact" data-up="${i}">▲</button>
      <button class="rowact" data-down="${i}">▼</button>
    </li>`).join('');
  const nudge = (i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= planOrder.length) return;
    [planOrder[i], planOrder[j]] = [planOrder[j], planOrder[i]];
    flags = [];
    rerender();
  };
  rows.querySelectorAll('[data-up]').forEach((b) =>
    b.addEventListener('click', () => nudge(+b.dataset.up, -1)));
  rows.querySelectorAll('[data-down]').forEach((b) =>
    b.addEventListener('click', () => nudge(+b.dataset.down, +1)));
}
