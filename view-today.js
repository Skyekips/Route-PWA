// Today: scan/add packages for the day, review them, slot them into the route, start driving.

import * as db from './db.js';
import { icon } from './icons.js';
import { backboneWithInsertions, enforceLoadOrder, deliveryOrder } from './logic.js';
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
    <div id="ordersec"></div>
    <div class="pad"><button class="btn danger outline" id="clear">End day — archive & clear the day</button></div>
    <div id="historysec" class="pad"></div>`;

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
    if (confirm('End the day? Today gets archived to Previous days, then cleared.')) {
      db.clearToday(pid); toast('Day archived'); rerender();
    }
  });

  // ── Previous days (archived on End day, last 30) ──────────────────────────
  const history = db.getHistory(pid);
  root.querySelector('#historysec').innerHTML = history.length ? `
    <h3 class="muted">Previous days</h3>
    ${history.map((d) => {
      const pkgs = d.entries.reduce((a, e) => a + (e.packageCount || 0), 0);
      const doneN = d.entries.filter((e) => e.completed).length;
      return `
        <details class="card" style="margin:8px 0">
          <summary><strong>${esc(d.date)}</strong>
            <span class="muted"> — ${doneN} completed · ${pkgs} parcels</span></summary>
          <ul class="list" style="margin-top:8px">
            ${d.entries.map((e) => `
              <li class="row"><span class="rowtext" style="padding:6px 4px">
                <strong>${e.completed ? '✓ ' : ''}${esc(e.address)}</strong>
                <small>${[e.box ? `Box ${esc(e.box)}` : null, e.packageCount ? `×${e.packageCount}` : null,
                          e.writeUpCount ? `${e.writeUpCount} write-up` : null].filter(Boolean).join(' · ')}</small>
              </span></li>`).join('')}
          </ul>
        </details>`;
    }).join('')}` : '';

  // ── Today's run order — the same sequence Drive uses, fine-tunable with the arrows ──
  const dayOrder = deliveryOrder(stops, t.packages, db.getOfficial(pid), [], t.order, db.getRoadPolyline(pid));
  const ordersec = root.querySelector('#ordersec');
  if (dayOrder.length >= 2) {
    ordersec.innerHTML = `
      <h3 class="muted pad">Run order (${dayOrder.length}) — nudge with the arrows; Drive follows this</h3>
      <ul class="list">${dayOrder.map((s, i) => {
        const p = t.packages[s.id];
        const bits = [s.box ? `Box ${esc(s.box)}` : null, p?.packageCount ? `×${p.packageCount}` : null,
                      s.routeStop ? 'box stop' : null].filter(Boolean).join(' · ');
        return `
          <li class="row">
            <span class="num">${i + 1}</span>
            <span class="rowtext"><strong>${esc(s.address)}</strong>${bits ? `<small>${bits}</small>` : ''}</span>
            <button class="rowact" data-oup="${i}">▲</button>
            <button class="rowact" data-odn="${i}">▼</button>
          </li>`;
      }).join('')}</ul>`;
    // First nudge materializes the computed order as today's explicit order, then swaps within it.
    const nudge = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= dayOrder.length) return;
      const ids = dayOrder.map((s) => s.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      db.setTodayOrder(pid, ids);
      rerender();
    };
    ordersec.querySelectorAll('[data-oup]').forEach((b) =>
      b.addEventListener('click', () => nudge(+b.dataset.oup, -1)));
    ordersec.querySelectorAll('[data-odn]').forEach((b) =>
      b.addEventListener('click', () => nudge(+b.dataset.odn, +1)));
  } else {
    ordersec.innerHTML = '';
  }
}
