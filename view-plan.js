// Plan: the base-route workbench — map with tap-to-refine, optimize (straight/road), generate
// load-order groups, save as official, and review load-order conflicts. Backbone only (box/route
// stops + anchors); houses live in Stops, the day's packages in Today.

import * as db from './db.js';
import { icon } from './icons.js';
import { optimizeStraightLine, optimizeByRoad } from './geo.js';
import { enforceLoadOrder, generateLoadOrder, loadOrderNum } from './logic.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let planOrder = null;      // working order (stop ids) while on this tab
let flags = [];            // load-order conflict strings from the last optimize
let map = null;            // Leaflet instance
let mapView = null;        // preserved camera across re-renders
let refining = false;      // tap-to-refine mode
let picked = [];           // stop ids in tapped order

export function renderPlan(root, ctx) {
  const { pid, toast, rerender } = ctx;
  const stops = db.getStops(pid).filter((s) => s.routeStop || s.anchor);
  const byId = new Map(stops.map((s) => [s.id, s]));

  // Working order: previous session on this tab → official → load-order sort.
  let order;
  if (planOrder && planOrder.length === stops.length && planOrder.every((id) => byId.has(id))) {
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
    <header class="bar"><h1>Plan</h1><span class="bar-note">${stops.length} route stops</span></header>
    <div id="planmap" class="drive-map"></div>
    <div class="btnrow pad" id="refinebar">
      ${refining ? `
        <span class="muted" id="refcount">Tap pins in drive order — 0 of ${stops.filter((s) => s.lat != null).length}</span>
        <button class="btn primary" id="ref-apply">Apply</button>
        <button class="btn outline" id="ref-cancel">Cancel</button>
      ` : `
        <button class="btn outline" id="ref-start">${icon('place')} Tap to refine</button>
      `}
    </div>
    ${refining ? '' : `
    <div class="btnrow pad wrap">
      <button class="btn outline" id="opt-line">${icon('bolt')} Optimize (straight)</button>
      <button class="btn outline" id="opt-road">${icon('route')} Optimize by road</button>
      <button class="btn outline" id="gen-load">${icon('listNumbered')} Generate load order</button>
      <button class="btn primary" id="save-official">${icon('save')} Save as official</button>
    </div>`}
    <p id="status" class="muted pad"></p>
    <div id="conflicts"></div>
    <ul class="list" id="rows"></ul>`;

  const status = root.querySelector('#status');

  // ── Map with numbered pins (and tap-to-refine picking) ──────────────────────
  const mapEl = root.querySelector('#planmap');
  if (typeof L !== 'undefined') {
    if (map) {
      try { mapView = { center: map.getCenter(), zoom: map.getZoom() }; map.remove(); } catch (e) { /* gone */ }
      map = null;
    }
    map = L.map(mapEl, { zoomControl: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: '© OpenStreetMap' }).addTo(map);
    const pts = order.filter((s) => s.lat != null);
    const line = pts.map((s) => [s.lat, s.lon]);
    if (line.length > 1 && !refining) L.polyline(line, { color: '#1a73e8', opacity: 0.45 }).addTo(map);

    pts.forEach((s) => {
      const idx = order.indexOf(s);
      const pickPos = picked.indexOf(s.id);
      const isPicked = pickPos >= 0;
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 9, color: '#fff', weight: 2,
        fillColor: refining ? (isPicked ? '#188038' : '#9aa0a6') : '#1a73e8',
        fillOpacity: 1,
      }).addTo(map);
      m.bindTooltip(refining ? (isPicked ? String(pickPos + 1) : '·') : String(idx + 1),
        { permanent: true, direction: 'center', className: 'pin-num' });
      m.on('click', () => {
        if (!refining || picked.includes(s.id)) return;
        picked.push(s.id);
        m.setStyle({ fillColor: '#188038' });
        m.setTooltipContent(String(picked.length));
        const rc = root.querySelector('#refcount');
        if (rc) rc.textContent = `Tap pins in drive order — ${picked.length} of ${pts.length}`;
      });
    });
    if (mapView) map.setView(mapView.center, mapView.zoom);
    else if (pts.length) map.fitBounds(line, { padding: [30, 30], maxZoom: 15 });
    else map.setView([61.541, -151.271], 10);
  } else {
    mapEl.textContent = 'Map library not loaded (offline?) — the list below still works.';
  }

  // ── Refine controls ─────────────────────────────────────────────────────────
  root.querySelector('#ref-start')?.addEventListener('click', () => {
    refining = true; picked = [];
    rerender();
  });
  root.querySelector('#ref-cancel')?.addEventListener('click', () => {
    refining = false; picked = [];
    rerender();
  });
  root.querySelector('#ref-apply')?.addEventListener('click', () => {
    if (picked.length < 2) { refining = false; picked = []; rerender(); return; }
    // Tapped sequence first, untapped stops after in their current relative order. Manual refine
    // is sovereign (it IS your route knowledge) — no load-order enforcement here.
    const pickedSet = new Set(picked);
    planOrder = [...picked, ...order.map((s) => s.id).filter((id) => !pickedSet.has(id))];
    refining = false; picked = []; flags = [];
    toast('Order refined — save as official to keep it.');
    rerender();
  });

  // ── Optimize / generate / save ──────────────────────────────────────────────
  function apply(newOrder, note) {
    const { order: fixed, violations } = enforceLoadOrder(newOrder);
    flags = violations.map((vio) =>
      `${vio.stop.address} (load ${vio.stop.loadOrder}) — route wants it before group ${vio.conflictsWithGroup}; held back.`);
    planOrder = fixed.map((s) => s.id);
    status.textContent = flags.length ? `${note} — ${flags.length} stop(s) held back by load order.` : note;
    rerender();
  }

  root.querySelector('#opt-line')?.addEventListener('click', () =>
    apply(optimizeStraightLine(order), 'Optimized (straight-line).'));

  root.querySelector('#opt-road')?.addEventListener('click', async () => {
    status.textContent = 'Optimizing by road…';
    try {
      const res = await optimizeByRoad(order);
      if (res.polyline?.length) db.setRoadPolyline(pid, res.polyline);
      apply(res.order, 'Optimized by road (polyline saved for daily package slotting).');
    } catch (e) { status.textContent = `Road optimize failed: ${e.message}`; }
  });

  root.querySelector('#gen-load')?.addEventListener('click', () => {
    const size = db.getGroupSize();
    const assignments = generateLoadOrder(order.filter((s) => s.routeStop), size);
    const all = db.getStops(pid).map((s) => assignments[s.id] ? { ...s, loadOrder: assignments[s.id] } : s);
    db.setStops(pid, all);
    flags = [];
    toast(`Load order generated — ${Object.keys(assignments).length} stops in groups of ${size}.`);
    rerender();
  });

  root.querySelector('#save-official')?.addEventListener('click', () => {
    db.setOfficial(pid, order.filter((s) => s.routeStop || s.anchor).map((s) => s.id));
    toast('Saved as official route.');
  });

  const conflicts = root.querySelector('#conflicts');
  conflicts.innerHTML = flags.length ? `
    <div class="card warn">
      <strong>${icon('warning', 16)} Load-order conflicts (${flags.length})</strong>
      ${flags.slice(0, 4).map((f) => `<p>${esc(f)}</p>`).join('')}
      ${flags.length > 4 ? `<p>…and ${flags.length - 4} more</p>` : ''}
      <p class="muted">Either re-generate the load order to match this route, or fix the stop's data.</p>
    </div>` : '';

  // ── Ordered list with ▲▼ nudges ─────────────────────────────────────────────
  const rows = root.querySelector('#rows');
  rows.innerHTML = order.map((s, i) => `
    <li class="row">
      <span class="num">${i + 1}</span>
      <span class="rowtext"><strong>${esc(s.address)}</strong>
        <small>${[s.anchor ? esc(s.anchor).toUpperCase() : null, s.routeStop ? 'box stop' : null,
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
