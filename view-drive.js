// Drive: ordered run for today — map, next-stop card with cluster alerts, Navigate → Google
// Maps (no in-app nav on the PWA), Done/Undo, and the full checkable stop list.

import * as db from './db.js';
import { icon } from './icons.js';
import { deliveryOrder, clusterAlerts, alertLabel, activeHold, activeForward } from './logic.js';

let lastCompletedId = null;   // most recent Done → the ↩ Undo chip
let map = null;               // current Leaflet instance
let mapView = null;           // preserved center/zoom so re-renders don't yank the camera

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Pin-first when the stop prefers it (a saved pin is the exact spot); else the typed address,
// falling back to the pin when there's no address at all.
function gmapsUrl(stop) {
  const usePin = stop.lat != null && (stop.navigateByPin || !stop.address);
  const dest = usePin ? `${stop.lat},${stop.lon}` : stop.address;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
}

export function renderDrive(root, ctx) {
  const { pid, toast, rerender } = ctx;
  const stops = db.getStops(pid);
  const t = db.getToday(pid);
  const roadLine = db.getRoadPolyline(pid);
  const ordered = deliveryOrder(stops, t.packages, db.getOfficial(pid), [], t.order, roadLine);
  const done = new Set(t.completed);
  const remaining = ordered.filter((s) => !done.has(s.id));
  const cur = remaining[0] || null;

  root.innerHTML = `
    <header class="bar">
      <h1>Drive</h1>
      <span class="bar-note">${remaining.length} of ${ordered.length} left</span>
      ${lastCompletedId != null ? `<button class="chip" id="undo">↩ Undo</button>` : ''}
    </header>
    <div id="map" class="drive-map"></div>
    <section id="next"></section>
    <ul class="list" id="stops"></ul>`;

  // ── Map (Leaflet, OSM tiles) ──────────────────────────────────────────────
  const mapEl = root.querySelector('#map');
  if (typeof L !== 'undefined') {
    // Tear down the previous instance (leaks listeners otherwise) but keep its camera, so
    // checking off a stop doesn't yank the view back out to the whole route.
    if (map) {
      try { mapView = { center: map.getCenter(), zoom: map.getZoom() }; map.remove(); } catch (e) { /* gone */ }
      map = null;
    }
    map = L.map(mapEl, { zoomControl: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: '© OpenStreetMap' }).addTo(map);
    const pts = remaining.filter((s) => s.lat != null);
    if (roadLine && roadLine.length > 1) L.polyline(roadLine, { color: '#1a73e8', opacity: 0.5 }).addTo(map);
    pts.forEach((s, i) => {
      const m = L.circleMarker([s.lat, s.lon], {
        radius: i === 0 ? 10 : 7,
        color: '#fff', weight: 2,
        fillColor: i === 0 ? '#ea4335' : '#1a73e8', fillOpacity: 1,
      }).addTo(map);
      m.bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: 'pin-num' });
    });
    if (mapView) map.setView(mapView.center, mapView.zoom);
    else if (pts.length) map.fitBounds(pts.map((s) => [s.lat, s.lon]), { padding: [30, 30], maxZoom: 16 });
    else map.setView([61.541, -151.271], 10);
  } else {
    mapEl.textContent = 'Map library not loaded (offline?) — the list below still works.';
  }

  // ── Next-stop card ────────────────────────────────────────────────────────
  const next = root.querySelector('#next');
  if (!cur) {
    next.innerHTML = `<div class="card center"><h2>${icon('check', 28)} Route complete!</h2></div>`;
  } else {
    const pkg = t.packages[cur.id];
    const count = pkg?.packageCount || 0;
    const details = [
      cur.box ? `Box ${esc(cur.box)}` : null,
      cur.slotSize ? esc(cur.slotSize) : null,
      count ? `${count} pkg${count > 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(' · ');
    const alerts = clusterAlerts(cur, stops, t.handledAlerts, t.packages);
    next.innerHTML = `
      <div class="card next">
        <h2>${esc(cur.address)}</h2>
        ${details ? `<p class="muted">${details}</p>` : ''}
        ${cur.notes ? `<p class="note">${esc(cur.notes)}</p>` : ''}
        ${alerts.length ? `<ul class="alerts">${alerts.map((a) => `
          <li>
            <label class="${a.handled ? 'handled' : ''}">
              <input type="checkbox" data-key="${esc(a.key)}" data-type="${a.type}" data-stop="${a.stopId}"
                     ${a.handled ? 'checked' : ''}/>
              <span>${esc(alertLabel(a))}${a.until ? ` <em>until ${esc(a.until)}</em>` : ''}</span>
            </label>
          </li>`).join('')}</ul>` : ''}
        <div class="btnrow">
          <a class="btn outline" href="${gmapsUrl(cur)}" target="_blank" rel="noopener">${icon('navigation')} Navigate</a>
          <button class="btn primary" id="done">${icon('check')} Done</button>
        </div>
      </div>`;

    next.querySelectorAll('input[type=checkbox]').forEach((cb) =>
      cb.addEventListener('change', () => {
        db.setAlertHandled(pid, cb.dataset.key, cb.checked);
        // Loading a locker package IS the delivery — same semantics as the app.
        if (cb.dataset.type === 'LOCKER') db.markCompleted(pid, +cb.dataset.stop, cb.checked);
        rerender();
      }));
    next.querySelector('#done').addEventListener('click', () => {
      db.markCompleted(pid, cur.id, true);
      db.clearLockerFlag(pid, cur.id);
      lastCompletedId = cur.id;
      toast(`✓ Completed — ${cur.address}`);
      rerender();
    });
  }

  root.querySelector('#undo')?.addEventListener('click', () => {
    db.markCompleted(pid, lastCompletedId, false);
    lastCompletedId = null;
    toast('↩ Restored');
    rerender();
  });

  // ── Full list ─────────────────────────────────────────────────────────────
  const list = root.querySelector('#stops');
  list.innerHTML = ordered.map((s, i) => {
    const isDone = done.has(s.id);
    const pkg = t.packages[s.id];
    const bits = [
      s.box ? `Box ${esc(s.box)}` : null,
      pkg?.packageCount ? `×${pkg.packageCount}` : null,
      activeHold(s) ? 'Hold' : null,
      activeForward(s) ? `Fwd: ${esc(activeForward(s))}` : null,
    ].filter(Boolean).join(' · ');
    return `
      <li class="row ${isDone ? 'done' : ''} ${s.id === cur?.id ? 'current' : ''}">
        <button class="rowmain" data-id="${s.id}">
          <span class="num">${isDone ? '✓' : i + 1}</span>
          <span class="rowtext"><strong>${esc(s.address)}</strong>${bits ? `<small>${bits}</small>` : ''}</span>
        </button>
        <button class="rowact" data-toggle="${s.id}">${isDone ? '↩' : '✓'}</button>
      </li>`;
  }).join('');

  list.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = +b.dataset.toggle;
      const was = done.has(id);
      db.markCompleted(pid, id, !was);
      if (!was) { db.clearLockerFlag(pid, id); lastCompletedId = id; }
      rerender();
    }));
  list.querySelectorAll('.rowmain').forEach((b) =>
    b.addEventListener('click', () => {
      const s = stops.find((x) => x.id === +b.dataset.id);
      if (s?.lat != null && map) map.setView([s.lat, s.lon], 16);
    }));
}
