// Today: scan/add packages for the day, review them, slot them into the route, start driving.

import * as db from './db.js';
import { icon } from './icons.js';
import { backboneWithInsertions, enforceLoadOrder } from './logic.js';
import { optimizeByRoad } from './geo.js';
import { findMatches, findFuzzyMatches } from './fuzzy.js';
import { openScanner } from './view-scan.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderToday(root, ctx) {
  const { pid, toast, rerender, navigate } = ctx;
  const stops = db.getStops(pid);
  let t = db.getToday(pid);

  // Prune ghost package entries (keys that match no stop — e.g. the "NaN" rows an earlier
  // search bug wrote). Keeps counts honest for anyone who hit that build.
  const validIds = new Set(stops.map((s) => String(s.id)));
  const ghosts = Object.keys(t.packages).filter((k) => !validIds.has(k));
  if (ghosts.length) {
    ghosts.forEach((k) => delete t.packages[k]);
    db.setToday(pid, t);
    t = db.getToday(pid);
  }

  const entries = Object.entries(t.packages);
  const totals = entries.reduce((a, [, p]) => ({
    pkgs: a.pkgs + (p.packageCount || 0),
    writeUps: a.writeUps + (p.writeUpCount || 0),
    cands: a.cands + (p.lockerCandidateCount || 0),
  }), { pkgs: 0, writeUps: 0, cands: 0 });

  root.innerHTML = `
    <header class="bar"><h1>Today</h1>
      <span class="bar-note">${totals.pkgs} pkg · ${totals.writeUps} write-up · ${totals.cands} cand.</span>
    </header>
    <div class="btnrow pad">
      <button class="btn primary" id="scan">${icon('camera')} Scan labels</button>
      <button class="btn outline" id="drive">${icon('truck')} Drive</button>
    </div>
    <div class="pad">
      <input id="search" class="input" placeholder="Add package by address…" autocomplete="off"/>
      <div id="matches"></div>
    </div>
    <div class="btnrow pad">
      <button class="btn outline" id="slot">Slot packages into route</button>
      <button class="btn outline" id="road">Optimize day by road</button>
    </div>
    <p id="status" class="muted pad"></p>
    <ul class="list" id="pkgs"></ul>
    <div class="pad"><button class="btn danger outline" id="clear">End day — clear packages & checkmarks</button></div>`;

  const status = root.querySelector('#status');

  root.querySelector('#scan').addEventListener('click', () => openScanner(ctx));
  root.querySelector('#drive').addEventListener('click', () => navigate('drive'));

  // ── Manual add with fuzzy matching (same matcher the scanner uses) ────────
  const search = root.querySelector('#search');
  const matches = root.querySelector('#matches');
  search.addEventListener('input', () => {
    const q = search.value.trim();
    matches.innerHTML = '';
    if (q.length < 2) return;
    // findMatches returns {stop, score} wrappers — unwrap before rendering.
    let found = findMatches(q, stops).map((m) => m.stop);
    if (!found.length) found = findFuzzyMatches(q, stops).map((m) => m.stop);
    matches.innerHTML = found.slice(0, 6).map((s) => `
      <button class="matchrow" data-id="${s.id}">${esc(s.address)}${s.box ? ` <small>Box ${esc(s.box)}</small>` : ''}</button>`).join('');
    matches.querySelectorAll('.matchrow').forEach((b) =>
      b.addEventListener('click', () => {
        db.addPackage(pid, +b.dataset.id);
        search.value = ''; matches.innerHTML = '';
        toast('Package added');
        rerender();
      }));
  });

  // ── Slot / optimize ───────────────────────────────────────────────────────
  root.querySelector('#slot').addEventListener('click', () => {
    const pool = stops.filter((s) => s.routeStop || s.anchor || (t.packages[s.id]?.packageCount || 0) > 0);
    const roadLine = db.getRoadPolyline(pid);
    const ordered = backboneWithInsertions(pool, db.getOfficial(pid), roadLine);
    db.setTodayOrder(pid, ordered.map((s) => s.id));
    status.textContent = roadLine ? 'Packages slotted along your roads.' : 'Packages slotted (straight-line — road-optimize once on Plan to improve).';
  });

  root.querySelector('#road').addEventListener('click', async () => {
    status.textContent = 'Optimizing by road…';
    try {
      const pool = stops.filter((s) => s.routeStop || s.anchor || (t.packages[s.id]?.packageCount || 0) > 0);
      const { order, polyline } = await optimizeByRoad(pool);
      const { order: fixed, violations } = enforceLoadOrder(order);
      db.setTodayOrder(pid, fixed.map((s) => s.id));
      if (polyline?.length) db.setRoadPolyline(pid, polyline);
      status.textContent = violations.length
        ? `Optimized by road — ${violations.length} stop(s) held back by load order.`
        : 'Optimized by road.';
    } catch (e) { status.textContent = `Road optimize failed: ${e.message}`; }
  });

  // ── Package list ──────────────────────────────────────────────────────────
  const byId = new Map(stops.map((s) => [s.id, s]));
  root.querySelector('#pkgs').innerHTML = entries.map(([idStr, p]) => {
    const s = byId.get(+idStr);
    if (!s) return '';
    const bits = [
      p.packageCount ? `×${p.packageCount}` : null,
      p.clusterBox ? 'locker' : null,
      p.lockerCandidateCount ? `cand. ×${p.lockerCandidateCount}` : null,
      p.writeUpCount ? `write-up ×${p.writeUpCount}` : null,
    ].filter(Boolean).join(' · ');
    return `
      <li class="row">
        <span class="rowtext"><strong>${esc(s.address)}</strong><small>${bits}</small></span>
        <button class="rowact" data-plus="${s.id}">+1</button>
        <button class="rowact" data-del="${s.id}">✕</button>
      </li>`;
  }).join('');
  root.querySelectorAll('[data-plus]').forEach((b) =>
    b.addEventListener('click', () => { db.addPackage(pid, +b.dataset.plus); rerender(); }));
  root.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => { db.removePackage(pid, +b.dataset.del); rerender(); }));

  root.querySelector('#clear').addEventListener('click', () => {
    if (confirm('Clear today’s packages, order, and checkmarks?')) { db.clearToday(pid); rerender(); }
  });
}
