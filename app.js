import * as db from './db.js';
import { findMatches, findFuzzyMatches } from './fuzzy.js';
import * as geo from './geo.js';
import { importXlsx, exportXlsx } from './xlsxio.js';

// ── tiny DOM helpers ──────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
}
const app = () => $('#app');
const toast = (msg) => {
  const t = el('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
};
const go = (hash) => { location.hash = hash; };

// Holds/forwards only count while today is within their from→until window (else they've cleared).
const todayStr = () => new Date().toISOString().slice(0, 10);
const within = (today, from, until) => !(from && today < from) && !(until && today > until);
const activeHold = (s) => (s.hold && within(todayStr(), s.holdFrom, s.holdUntil)) ? s.hold : null;
const activeForward = (s) => (s.forwardTo && within(todayStr(), s.forwardFrom, s.forwardUntil)) ? s.forwardTo : null;

// ── delivery-order build (mirrors DeliveryOrder/RouteBuilder) ──────────────────
function loadOrderNum(s) {
  const n = parseInt((s.loadOrder || '').split('.')[0].trim(), 10);
  return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}
function gapCost(prev, pkg, next) {
  const d = (a, b) => (a && b && a.lat != null && a.lon != null && b.lat != null && b.lon != null
    ? geo.haversine(a.lat, a.lon, b.lat, b.lon) : 0);
  return d(prev, pkg) + d(pkg, next) - d(prev, next);
}
function backboneWithInsertions(pool, officialIds) {
  const start = pool.find((s) => s.anchor === 'start');
  const finish = pool.find((s) => s.anchor === 'finish');
  const nonAnchor = pool.filter((s) => s.anchor == null);
  const byId = new Map(nonAnchor.map((s) => [s.id, s]));
  const backbone = [];
  const inBb = new Set();
  if (officialIds) for (const id of officialIds) { const s = byId.get(id); if (s && s.routeStop) { backbone.push(s); inBb.add(id); } }
  for (const s of nonAnchor) if (s.routeStop && !inBb.has(s.id)) { backbone.push(s); inBb.add(s.id); }
  const packages = nonAnchor.filter((s) => !inBb.has(s.id));
  const seq = [];
  if (start) seq.push(start);
  seq.push(...backbone);
  if (finish) seq.push(finish);
  const lo = start ? 1 : 0;
  for (const pkg of packages) {
    const hi = seq.length - (finish ? 1 : 0);
    if (pkg.lat == null || pkg.lon == null) { seq.splice(hi, 0, pkg); continue; }
    let bestPos = hi, bestCost = Infinity;
    for (let pos = lo; pos <= hi; pos++) {
      const c = gapCost(seq[pos - 1], pkg, seq[pos]);
      if (c < bestCost) { bestCost = c; bestPos = pos; }
    }
    seq.splice(bestPos, 0, pkg);
  }
  return seq;
}
function buildRun(pid) {
  const stops = db.getStops(pid);
  const t = db.getToday(pid);
  const official = db.getOfficial(pid);
  const pkgMap = t.packages || {};
  const pool = stops.filter((s) => s.routeStop || s.anchor != null || (pkgMap[s.id]?.packageCount > 0));
  let ordered;
  if (t.order) {
    const rank = new Map(t.order.map((id, i) => [id, i]));
    ordered = [...pool].sort((a, b) => {
      const ax = a.anchor === 'start' ? 0 : a.anchor === 'finish' ? 2 : 1;
      const bx = b.anchor === 'start' ? 0 : b.anchor === 'finish' ? 2 : 1;
      if (ax !== bx) return ax - bx;
      return (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) || loadOrderNum(a) - loadOrderNum(b);
    });
  } else if (official) {
    ordered = backboneWithInsertions(pool, official);
  } else {
    ordered = [...pool].sort((a, b) => {
      const ax = a.anchor === 'start' ? 0 : a.anchor === 'finish' ? 2 : 1;
      const bx = b.anchor === 'start' ? 0 : b.anchor === 'finish' ? 2 : 1;
      return ax - bx || loadOrderNum(a) - loadOrderNum(b) || a.address.localeCompare(b.address);
    });
  }
  return ordered.map((s) => ({ stop: s, packageCount: pkgMap[s.id]?.packageCount || 0 }));
}

// ── navigation links ──────────────────────────────────────────────────────────
function mapsHref(s) {
  if (s.lat != null && s.lon != null) return `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.address)}`;
}

// ── header ─────────────────────────────────────────────────────────────────────
function header(title, back) {
  return el('div', { class: 'topbar' },
    back ? el('button', { class: 'icon', onclick: () => go(back) }, '‹') : el('span', { class: 'logo-sq' }),
    el('h1', {}, title));
}

// ── HOME ────────────────────────────────────────────────────────────────────────
function viewHome() {
  const profiles = db.getProfiles();
  const activeId = db.getActiveProfileId();
  const root = el('div', {});
  root.append(el('div', { class: 'topbar' }, el('span', { class: 'logo-sq' }), el('h1', {}, 'Route'),
    el('button', { class: 'icon right', onclick: () => go('#/settings') }, '⚙')));

  if (!profiles.length) {
    root.append(el('div', { class: 'pad' },
      el('p', { class: 'muted' }, 'No profiles yet.'),
      el('button', { class: 'btn primary', onclick: newProfile }, '+ New profile')));
    return root;
  }

  const sel = el('select', { class: 'select', onchange: (e) => { db.setActiveProfileId(e.target.value); render(); } },
    ...profiles.map((p) => el('option', { value: p.id, ...(p.id === activeId ? { selected: 'selected' } : {}) }, p.name)));
  root.append(el('div', { class: 'pad row' }, sel,
    el('button', { class: 'btn small', onclick: newProfile }, '+'),
    el('button', { class: 'btn small', onclick: () => renameProfile(activeId) }, 'Rename')));

  const run = buildRun(activeId);
  const t = db.getToday(activeId);
  const pkgs = run.reduce((a, r) => a + r.packageCount, 0);
  const routeStops = run.filter((r) => r.stop.routeStop).length;
  root.append(el('div', { class: 'pad' },
    el('div', { class: 'card', onclick: () => go('#/today') },
      el('div', { class: 'muted' }, 'Today'),
      el('div', { class: 'stats' }, el('b', {}, String(pkgs)), ' pkgs   ', el('b', {}, String(routeStops)), ' route stops'))));

  const grid = el('div', { class: 'grid' },
    el('button', { class: 'tile', onclick: () => go('#/scan') }, '⛶  Scan'),
    el('button', { class: 'tile', onclick: () => go('#/map') }, '🗺  Map'),
    el('button', { class: 'tile', onclick: () => go('#/addresses') }, '☰  Addresses'),
    el('button', { class: 'tile', onclick: () => go('#/today') }, '▶  Today'));
  root.append(el('div', { class: 'pad' }, grid));

  // Quick address search (matches each typed word across number/street/box)
  const results = el('div', { class: 'list' });
  const searchBox = el('input', { class: 'input', placeholder: '🔎 Find an address…', oninput: (e) => {
    results.innerHTML = '';
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const terms = q.split(/\s+/).filter(Boolean);
    const hits = db.getStops(activeId).filter((s) => {
      if (!s.address) return false;
      const hay = [s.address, s.box, s.stop].filter(Boolean).join(' ').toLowerCase();
      return terms.every((tk) => hay.includes(tk));
    }).slice(0, 8);
    for (const s of hits) results.append(el('div', { class: 'row-item', onclick: () => go(`#/edit/${s.id}`) },
      el('div', { class: 'grow' }, el('div', {}, s.address), s.box ? el('div', { class: 'muted small' }, `Box ${s.box}`) : null),
      el('span', { class: 'chev' }, '›')));
  } });
  root.append(el('div', { class: 'pad' }, searchBox), results);

  root.append(el('div', { class: 'pad row' },
    el('button', { class: 'btn', onclick: () => exportProfile(activeId) }, '⭱ Export .xlsx'),
    el('button', { class: 'btn', onclick: importProfile }, '⭳ Import .xlsx')));
  root.append(el('div', { class: 'pad' }, el('span', { class: 'muted small' }, `${db.getStops(activeId).filter((s) => s.address).length} addresses`)));
  return root;
}

function newProfile() {
  const name = prompt('Profile name?');
  if (name && name.trim()) { db.createProfile(name.trim()); render(); }
}
function renameProfile(id) {
  const p = db.getProfile(id); if (!p) return;
  const name = prompt('Rename profile', p.name);
  if (name && name.trim()) { db.renameProfile(id, name.trim()); render(); }
}

// ── ADDRESSES ─────────────────────────────────────────────────────────────────
function viewAddresses() {
  const pid = db.getActiveProfileId();
  const root = el('div', {});
  root.append(el('div', { class: 'topbar' }, el('button', { class: 'icon', onclick: () => go('#/home') }, '‹'),
    el('h1', {}, 'Addresses'),
    el('button', { class: 'icon right', onclick: () => go(`#/edit/new`) }, '+')));
  const listWrap = el('div', { class: 'list' });
  const search = el('input', { class: 'input', placeholder: 'Find an address…', oninput: (e) => renderList(e.target.value) });
  root.append(el('div', { class: 'pad' }, search), listWrap);

  function renderList(q = '') {
    listWrap.innerHTML = '';
    let stops = db.getStops(pid).filter((s) => s.address);
    if (q.trim()) {
      // Match each typed word anywhere in the stop's text, so "360 e" finds "360 Echo Lake".
      const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      stops = stops.filter((s) => {
        const hay = [s.address, s.box, s.stop].filter(Boolean).join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    stops.sort((a, b) => a.address.localeCompare(b.address));
    for (const s of stops.slice(0, 300)) {
      const sub = [s.box ? `Box ${s.box}` : null, s.routeStop ? 'Route stop' : null, activeHold(s) ? 'Hold' : null,
        activeForward(s) ? 'Fwd' : null, s.lat == null ? '⚠ no location' : null].filter(Boolean).join(' · ');
      listWrap.append(el('div', { class: 'row-item', onclick: () => go(`#/edit/${s.id}`) },
        el('div', {}, el('div', {}, s.address), sub ? el('div', { class: 'muted small' }, sub) : null),
        el('span', { class: 'chev' }, '›')));
    }
  }
  renderList();
  return root;
}

// ── EDIT STOP ──────────────────────────────────────────────────────────────────
function viewEdit(idParam) {
  const pid = db.getActiveProfileId();
  const isNew = idParam === 'new';
  const stop = isNew ? { ...db.STOP_DEFAULTS } : (db.getStop(pid, +idParam) || { ...db.STOP_DEFAULTS });
  const root = el('div', {});
  root.append(header(isNew ? 'New stop' : 'Edit stop', '#/addresses'));
  const f = {};
  const field = (label, key, type = 'text') => {
    f[key] = el('input', { class: 'input', type, value: stop[key] ?? '' });
    return el('label', { class: 'fld' }, el('span', {}, label), f[key]);
  };
  const body = el('div', { class: 'pad form' });
  body.append(field('Address', 'address'));
  body.append(field('Box', 'box'));
  // route stop toggle
  f.routeStop = el('input', { type: 'checkbox', ...(stop.routeStop ? { checked: 'checked' } : {}) });
  body.append(el('label', { class: 'fld row' }, el('span', {}, 'Route stop (cluster box / CBU)'), f.routeStop));
  body.append(field('Load order', 'loadOrder'));
  // slot size + status selects
  f.slotSize = el('select', { class: 'select' }, ...['', 'standard', 'small', 'large'].map((o) =>
    el('option', { value: o, ...(o === (stop.slotSize || '') ? { selected: 'selected' } : {}) }, o || '—')));
  body.append(el('label', { class: 'fld' }, el('span', {}, 'Slot size'), f.slotSize));
  f.status = el('select', { class: 'select' }, ...['active', 'vacant', 'no_delivery', 'business'].map((o) =>
    el('option', { value: o, ...(o === (stop.status || 'active') ? { selected: 'selected' } : {}) }, o)));
  body.append(el('label', { class: 'fld' }, el('span', {}, 'Status'), f.status));
  body.append(field('Hold note', 'hold'));
  body.append(el('div', { class: 'row' }, field('Hold from', 'holdFrom', 'date'), field('Hold until', 'holdUntil', 'date')));
  body.append(field('Forward (names)', 'forwardTo'));
  body.append(el('div', { class: 'row' }, field('Fwd from', 'forwardFrom', 'date'), field('Fwd until', 'forwardUntil', 'date')));
  body.append(field('Notes', 'notes'));

  const locLine = el('div', { class: 'muted small' }, stop.lat != null ? `📍 ${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}` : 'No location yet');
  const geoBtn = el('button', { class: 'btn', onclick: async () => {
    const addr = f.address.value.trim(); if (!addr) { toast('Enter an address first'); return; }
    geoBtn.disabled = true; geoBtn.textContent = 'Geocoding…';
    try { const g = await geo.geocode(addr); stop.lat = g.lat; stop.lon = g.lon; stop.placeId = g.placeId; stop.geocodeType = g.geocodeType;
      locLine.textContent = `📍 ${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`; toast('Located'); }
    catch (e) { toast('Geocode failed: ' + e.message); }
    finally { geoBtn.disabled = false; geoBtn.textContent = 'Find location'; }
  } }, 'Find location');
  body.append(el('div', { class: 'row' }, geoBtn, locLine));

  body.append(el('div', { class: 'row pad-top' },
    el('button', { class: 'btn primary', onclick: save }, 'Save'),
    isNew ? null : el('button', { class: 'btn danger', onclick: () => { db.deleteStop(pid, stop.id); go('#/addresses'); } }, 'Delete')));
  root.append(body);

  function save() {
    stop.address = f.address.value.trim();
    if (!stop.address) { toast('Address required'); return; }
    stop.box = f.box.value.trim() || null;
    stop.routeStop = f.routeStop.checked;
    stop.loadOrder = f.loadOrder.value.trim() || null;
    stop.slotSize = f.slotSize.value || null;
    stop.status = f.status.value || 'active';
    for (const k of ['hold', 'holdFrom', 'holdUntil', 'forwardTo', 'forwardFrom', 'forwardUntil', 'notes'])
      stop[k] = f[k].value.trim() || null;
    stop.profileId = pid;
    db.upsertStop(pid, stop);
    toast('Saved'); go('#/addresses');
  }
  return root;
}

// ── TODAY ───────────────────────────────────────────────────────────────────────
function viewToday() {
  const pid = db.getActiveProfileId();
  const root = el('div', {});
  root.append(el('div', { class: 'topbar' }, el('button', { class: 'icon', onclick: () => go('#/home') }, '‹'),
    el('h1', {}, 'Today'),
    el('button', { class: 'icon right', onclick: () => go('#/scan') }, '⛶')));

  const run = buildRun(pid);
  const t = db.getToday(pid);
  const writeUps = Object.entries(t.packages || {}).filter(([, p]) => p.writeUpCount > 0)
    .map(([id, p]) => ({ stop: db.getStop(pid, +id), count: p.writeUpCount })).filter((x) => x.stop);
  const lockerCands = Object.entries(t.packages || {}).filter(([, p]) => (p.lockerCandidateCount || 0) > 0)
    .map(([id, p]) => ({ stop: db.getStop(pid, +id), count: p.lockerCandidateCount })).filter((x) => x.stop);

  const pkgs = run.reduce((a, r) => a + r.packageCount, 0);
  root.append(el('div', { class: 'pad statbar' },
    el('span', { class: 'chip' }, `${pkgs} pkgs`),
    el('span', { class: 'chip' }, `${run.filter((r) => r.packageCount > 0).length} stops w/ pkgs`),
    el('span', { class: 'chip' }, `${run.filter((r) => r.stop.routeStop).length} route stops`),
    writeUps.length ? el('span', { class: 'chip warn' }, `⚠ ${writeUps.reduce((a, w) => a + w.count, 0)} write-ups`) : null,
    lockerCands.length ? el('span', { class: 'chip' }, `📦 ${lockerCands.reduce((a, w) => a + w.count, 0)} locker cand.`) : null));

  root.append(el('div', { class: 'pad row wrap' },
    el('button', { class: 'btn small', onclick: () => optimize(pid, 'slot') }, '✦ Slot packages'),
    el('button', { class: 'btn small', onclick: () => optimize(pid, 'road') }, '⛓ Optimize by road'),
    el('button', { class: 'btn small', onclick: () => optimize(pid, 'line') }, '⚡ Optimize (fast)'),
    el('button', { class: 'btn small', onclick: () => go('#/map') }, '🗺 Map')));

  const list = el('div', { class: 'list' });
  run.forEach((r, i) => {
    const s = r.stop;
    const sub = [s.box ? `Box ${s.box}` : null, s.slotSize, activeHold(s) ? 'Hold' : null, activeForward(s) ? 'Fwd' : null,
      s.anchor].filter(Boolean).join(' · ');
    list.append(el('div', { class: 'row-item' },
      el('span', { class: 'num' }, String(i + 1)),
      el('div', { class: 'grow' }, el('div', {}, s.address), sub ? el('div', { class: 'muted small' }, sub) : null),
      r.packageCount > 0 ? el('span', { class: 'badge' }, `×${r.packageCount}`) : null,
      el('button', { class: 'icon', title: 'Up', onclick: () => move(pid, run, i, -1) }, '▲'),
      el('button', { class: 'icon', title: 'Down', onclick: () => move(pid, run, i, 1) }, '▼'),
      el('a', { class: 'icon', href: mapsHref(s), target: '_blank', rel: 'noopener' }, '➤')));
  });
  if (!run.length) list.append(el('div', { class: 'pad muted' }, 'Nothing scanned yet.'));
  root.append(list);

  if (writeUps.length) {
    root.append(el('div', { class: 'pad section err' }, 'Write-ups — note these on a slip'));
    const wl = el('div', { class: 'list' });
    for (const w of writeUps) wl.append(el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, w.stop.address, el('div', { class: 'muted small' }, `${w.count} package${w.count > 1 ? 's' : ''}`)),
      el('button', { class: 'icon', onclick: () => { db.removePackage(pid, w.stop.id); render(); } }, '✕')));
    root.append(wl);
  }

  if (lockerCands.length) {
    root.append(el('div', { class: 'pad section' }, 'Parcel-locker candidates — try the locker, not a delivery'));
    const ll = el('div', { class: 'list' });
    for (const w of lockerCands) ll.append(el('div', { class: 'row-item' },
      el('div', { class: 'grow' }, w.stop.address, el('div', { class: 'muted small' }, `${w.count} candidate${w.count > 1 ? 's' : ''}`)),
      el('button', { class: 'icon', onclick: () => { db.removePackage(pid, w.stop.id); render(); } }, '✕')));
    root.append(ll);
  }

  root.append(el('div', { class: 'pad' }, el('button', { class: 'btn danger', onclick: () => {
    if (confirm('Clear today? Removes scanned packages + check-offs. Addresses stay.')) { db.clearToday(pid); render(); }
  } }, 'Clear Today')));
  return root;
}

function move(pid, run, i, dir) {
  const ids = run.map((r) => r.stop.id);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  db.setTodayOrder(pid, ids);
  render();
}

async function optimize(pid, kind) {
  const run = buildRun(pid).map((r) => r.stop);
  if (kind === 'slot') {
    const ordered = backboneWithInsertions(run, db.getOfficial(pid));
    db.setTodayOrder(pid, ordered.map((s) => s.id)); toast('Packages slotted in'); render(); return;
  }
  if (kind === 'line') {
    const ordered = geo.optimizeStraightLine(run);
    db.setTodayOrder(pid, ordered.map((s) => s.id)); toast('Reordered by distance'); render(); return;
  }
  toast('Optimizing by road…');
  try { const { order } = await geo.optimizeByRoad(run); db.setTodayOrder(pid, order.map((s) => s.id)); toast('Optimized by road'); render(); }
  catch (e) { toast(e.message); }
}

// ── MAP ───────────────────────────────────────────────────────────────────────
let mapRef = null;
function viewMap() {
  const pid = db.getActiveProfileId();
  const root = el('div', {});
  root.append(el('div', { class: 'topbar' }, el('button', { class: 'icon', onclick: () => go('#/home') }, '‹'),
    el('h1', {}, 'Map'),
    el('button', { class: 'btn small right', onclick: () => optimize(pid, 'road').then(() => go('#/map')) }, 'Optimize')));
  const mapEl = el('div', { id: 'leaflet', class: 'mapbox' });
  root.append(mapEl);
  setTimeout(() => drawMap(pid), 30);
  return root;
}
function drawMap(pid) {
  const run = buildRun(pid);
  const pts = run.filter((r) => r.stop.lat != null && r.stop.lon != null);
  if (mapRef) { mapRef.remove(); mapRef = null; }
  const map = L.map('leaflet');
  mapRef = map;
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  if (!pts.length) { map.setView([60.6884, -151.2466], 11); return; }
  const latlngs = [];
  pts.forEach((r, i) => {
    const s = r.stop;
    const color = s.anchor === 'start' ? '#1565C0' : s.anchor === 'finish' ? '#C62828' : s.routeStop ? '#1A5EA8' : '#F06292';
    const icon = L.divIcon({ className: 'pin', html: `<div class="pinbody" style="background:${color}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    const m = L.marker([s.lat, s.lon], { icon }).addTo(map);
    m.bindPopup(`<b>${s.address}</b>${s.box ? '<br>Box ' + s.box : ''}`);
    latlngs.push([s.lat, s.lon]);
  });
  L.polyline(latlngs, { color: '#1976D2', weight: 4, opacity: 0.6 }).addTo(map);
  map.fitBounds(latlngs, { padding: [40, 40] });
}

// ── SCAN ───────────────────────────────────────────────────────────────────────
let scanState = null;
function viewScan() {
  const pid = db.getActiveProfileId();
  const root = el('div', {});
  root.append(el('div', { class: 'topbar' }, el('button', { class: 'icon', onclick: () => { stopScan(); go('#/home'); } }, '‹'), el('h1', {}, 'Scan')));
  const video = el('video', { class: 'cam', autoplay: '', playsinline: '', muted: '' });
  const strip = el('div', { class: 'focusstrip' });
  const status = el('div', { class: 'scanstatus' }, 'Starting camera…');
  const added = el('div', { class: 'addedbar hidden' });
  const matchWrap = el('div', { class: 'matchwrap' });
  const camwrap = el('div', { class: 'camwrap' }, video, strip, status, added);
  // Tap the camera to clear a locked match and resume live scanning.
  camwrap.addEventListener('click', () => { if (scanState && scanState.matchWrap.childElementCount) rescan(); });
  root.append(camwrap, matchWrap);

  scanState = { pid, video, status, added, matchWrap, locked: false, firstSeen: 0, busy: false, worker: null, stream: null, timer: null, alive: true };
  startScan();
  return root;
}

async function startScan() {
  const st = scanState;
  try {
    st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    st.video.srcObject = st.stream;
    await st.video.play().catch(() => {});
  } catch (e) {
    st.status.textContent = 'Camera blocked — allow camera access for this site, then reopen Scan.';
    return;
  }
  if (typeof Tesseract === 'undefined') { st.status.textContent = 'Scanner library didn’t load — check your connection.'; return; }
  st.status.textContent = 'Loading scanner…';
  try {
    // ONE persistent worker, reused for every frame (the old code spun up a new one per frame).
    st.worker = await Tesseract.createWorker('eng');
  } catch (e) { st.status.textContent = 'Scanner failed to start: ' + (e.message || e); return; }
  if (!st.alive) { st.worker.terminate(); return; }
  st.status.textContent = 'Align address label in frame';
  st.timer = setInterval(() => scanTick(), 600);
}

function stopScan() {
  const st = scanState; if (!st) return;
  st.alive = false;
  if (st.timer) clearInterval(st.timer);
  st.stream && st.stream.getTracks().forEach((t) => t.stop());
  if (st.worker) { try { st.worker.terminate(); } catch {} }
  scanState = null;
}

async function scanTick() {
  const st = scanState; if (!st || !st.alive || st.locked || st.busy || !st.worker) return;
  const v = st.video; if (!v.videoWidth) return;
  st.busy = true;
  try {
    const c = document.createElement('canvas');
    const sw = v.videoWidth, sh = v.videoHeight;
    const top = Math.floor(sh * 0.16), h = Math.floor(sh * 0.30);   // crop to the focus strip
    c.width = sw; c.height = h;
    c.getContext('2d').drawImage(v, 0, top, sw, h, 0, 0, sw, h);
    const { data: { text } } = await st.worker.recognize(c);
    if (!st.alive || st.locked) return;
    const allText = (text || '').replace(/\n/g, ' ').trim();
    if (!allText) return;
    if (!st.firstSeen) st.firstSeen = Date.now();
    const candidates = db.getStops(st.pid).filter((s) => !s.routeStop && s.anchor == null && s.address);
    let found = findMatches(allText, candidates);
    if (!found.length && Date.now() - st.firstSeen > 1250) found = findFuzzyMatches(allText, candidates);
    if (found.length) { st.locked = true; showMatches(found); }
  } catch { /* skip this frame */ } finally { st.busy = false; }
}
function showMatches(matches) {
  const st = scanState;
  st.status.textContent = 'Tap a match · or Rescan';
  st.matchWrap.innerHTML = '';
  for (const m of matches) {
    const s = m.stop;
    const flag = activeHold(s) ? 'HOLD' : activeForward(s) ? 'FWD' : s.status === 'vacant' ? 'VACANT' : s.status === 'no_delivery' ? 'NO DEL' : null;
    const sub = [s.box ? `Box ${s.box}` : null, s.slotSize].filter(Boolean).join(' · ');
    st.matchWrap.append(el('div', { class: 'matchcard' + (flag ? ' flag' : '') },
      el('div', { class: 'grow' }, el('div', { class: 'maddr' }, s.address), sub ? el('div', { class: 'muted small' }, sub) : null),
      flag ? el('span', { class: 'flagchip' }, flag) : null,
      el('button', { class: 'btn small', onclick: () => addPkg(s, false, false) }, 'Add'),
      el('button', { class: 'btn small', onclick: () => addPkg(s, true, false) }, 'Locker'),
      el('button', { class: 'btn small', onclick: () => addPkg(s, false, false, true) }, 'Locker cand.'),
      el('button', { class: 'btn small warn', onclick: () => addPkg(s, false, true) }, 'Write-up')));
  }
  st.matchWrap.append(el('button', { class: 'btn', onclick: rescan }, '✕ Rescan'));
}
function rescan() {
  const st = scanState; if (!st) return;
  st.locked = false; st.firstSeen = 0; st.matchWrap.innerHTML = '';
  st.status.textContent = 'Align address label in frame';
}
function addPkg(stop, locker, writeUp, lockerCandidate = false) {
  const st = scanState;
  db.addPackage(st.pid, stop.id, locker, writeUp, lockerCandidate);
  const verb = writeUp ? 'Write-up' : lockerCandidate ? 'Locker candidate' : locker ? 'Locker' : 'Added';
  st.added.textContent = `✓ ${verb}: ${stop.address}`;
  st.added.classList.remove('hidden');
  rescan();
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function viewSettings() {
  const root = el('div', {});
  root.append(header('Settings', '#/home'));
  const key = el('input', { class: 'input', value: db.getApiKey(), placeholder: 'Google Maps API key' });
  const city = el('input', { class: 'input', value: db.getCityHint(), placeholder: 'City hint (e.g. Soldotna AK)' });
  root.append(el('div', { class: 'pad form' },
    el('label', { class: 'fld' }, el('span', {}, 'Google Maps API key'), key),
    el('label', { class: 'fld' }, el('span', {}, 'City/area hint (helps geocoding)'), city),
    el('p', { class: 'muted small' }, 'Enable Maps JavaScript API + Geocoding + Directions on your key. Used for the map, locating addresses, and route optimization.'),
    el('button', { class: 'btn primary', onclick: () => { db.setApiKey(key.value.trim()); db.setCityHint(city.value.trim()); toast('Saved'); } }, 'Save')));
  return root;
}

// ── import / export ──────────────────────────────────────────────────────────
function exportProfile(pid) {
  const stops = db.getStops(pid);
  const blob = exportXlsx(stops, db.getOfficial(pid));
  const name = (db.getProfile(pid)?.name || 'route').replace(/[^a-z0-9]+/gi, '_');
  const a = el('a', { href: URL.createObjectURL(blob), download: `${name}.xlsx` });
  document.body.append(a); a.click(); a.remove();
}
function importProfile() {
  const input = el('input', { type: 'file', accept: '.xlsx', class: 'hidden' });
  input.addEventListener('change', async () => {
    const file = input.files[0]; if (!file) return;
    const name = prompt('Name for the imported profile?', file.name.replace(/\.xlsx$/i, '')) || file.name;
    try {
      const buf = await file.arrayBuffer();
      const { stops, official } = importXlsx(buf);
      const id = db.createProfile(name.trim());
      stops.forEach((s) => { s.profileId = id; });
      db.setStops(id, stops);
      if (official) db.setOfficial(id, official);
      toast(`Imported ${stops.length} addresses`); render();
    } catch (e) { toast('Import failed: ' + e.message); }
  });
  document.body.append(input); input.click(); input.remove();
}

// ── router ───────────────────────────────────────────────────────────────────
function render() {
  const hash = location.hash || '#/home';
  if (!hash.startsWith('#/scan')) stopScan();
  const [, route, param] = hash.split('/');
  const container = app();
  container.innerHTML = '';
  let view;
  switch (route) {
    case 'addresses': view = viewAddresses(); break;
    case 'edit': view = viewEdit(param); break;
    case 'today': view = viewToday(); break;
    case 'map': view = viewMap(); break;
    case 'scan': view = viewScan(); break;
    case 'settings': view = viewSettings(); break;
    default: view = viewHome();
  }
  container.append(view);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);
window.addEventListener('load', () => {
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
