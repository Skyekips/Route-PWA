// Stops: the address book — search, add, edit every field the Android app has, geocode.

import * as db from './db.js';
import { icon } from './icons.js';
import { geocode } from './geo.js';
import { activeHold, activeForward, activeCheck } from './logic.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderStops(root, ctx) {
  const { pid, rerender } = ctx;
  const stops = db.getStops(pid);

  root.innerHTML = `
    <header class="bar"><h1>Stops</h1><span class="bar-note">${stops.length}</span>
      <button class="chip" id="add">Add</button>
    </header>
    <div class="pad"><input id="q" class="input" placeholder="Search address / box…" autocomplete="off"/></div>
    <ul class="list" id="rows"></ul>`;

  const rows = root.querySelector('#rows');
  const q = root.querySelector('#q');

  function draw() {
    const term = q.value.trim().toLowerCase();
    const filtered = !term ? stops : stops.filter((s) =>
      (s.address || '').toLowerCase().includes(term) || (s.box || '').toLowerCase().includes(term));
    rows.innerHTML = filtered.slice(0, 200).map((s) => {
      const flags = [
        s.routeStop ? 'box stop' : null,
        s.anchor ? esc(s.anchor).toUpperCase() : null,
        s.loadOrder ? `Load ${esc(s.loadOrder)}` : null,
        activeHold(s) ? 'Hold' : null,
        activeForward(s) ? 'Fwd' : null,
        activeCheck(s) ? 'Check' : null,
        s.lat == null ? 'no pin' : null,
      ].filter(Boolean).join(' · ');
      return `
        <li class="row">
          <button class="rowmain" data-edit="${s.id}">
            <span class="rowtext"><strong>${esc(s.address)}</strong>${flags ? `<small>${flags}</small>` : ''}</span>
          </button>
        </li>`;
    }).join('');
    rows.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => openEditor(ctx, db.getStop(pid, +b.dataset.edit))));
  }
  q.addEventListener('input', draw);
  draw();

  root.querySelector('#add').addEventListener('click', () =>
    openEditor(ctx, { ...db.STOP_DEFAULTS }));
}

function field(label, id, value, placeholder = '') {
  return `<label class="field"><span>${label}</span>
    <input class="input" id="${id}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}"/></label>`;
}

function openEditor(ctx, stop) {
  const { pid, toast, rerender } = ctx;
  const overlay = document.createElement('div');
  overlay.className = 'overlay scroll';
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${stop.id ? 'Edit stop' : 'New stop'}</h2>
      ${field('Address', 'f-address', stop.address, '123 Smith Rd')}
      <div class="fieldrow">
        ${field('Box', 'f-box', stop.box)}
        ${field('Slot size', 'f-slot', stop.slotSize)}
        ${field('Load order', 'f-load', stop.loadOrder, 'e.g. 2.14')}
      </div>
      <label class="field check"><input type="checkbox" id="f-routestop" ${stop.routeStop ? 'checked' : ''}/>
        <span>Box/cluster stop (you park here; serves the boxes below)</span></label>
      ${field('Boxes served (comma-sep)', 'f-served', (stop.boxesServed || []).join(','))}
      <div class="fieldrow">
        ${field('Anchor', 'f-anchor', stop.anchor, 'start / finish / blank')}
        ${field('Status', 'f-status', stop.status, 'active')}
      </div>
      <h3>Alerts</h3>
      ${field('Hold (reason)', 'f-hold', stop.hold)}
      <div class="fieldrow">
        ${field('Hold from', 'f-holdfrom', stop.holdFrom, 'YYYY-MM-DD')}
        ${field('Hold until', 'f-holduntil', stop.holdUntil, 'YYYY-MM-DD')}
      </div>
      ${field('Forward (names)', 'f-fwd', stop.forwardTo)}
      <div class="fieldrow">
        ${field('Fwd from', 'f-fwdfrom', stop.forwardFrom, 'YYYY-MM-DD')}
        ${field('Fwd until', 'f-fwduntil', stop.forwardUntil, 'YYYY-MM-DD')}
      </div>
      <div class="fieldrow">
        ${field('Check for (name)', 'f-check', stop.checkName)}
        ${field('Check until', 'f-checkuntil', stop.checkUntil, 'YYYY-MM-DD')}
      </div>
      ${field('Notes', 'f-notes', stop.notes)}
      <p class="muted">${stop.lat != null ? `Pinned: ${stop.lat.toFixed(5)}, ${stop.lon.toFixed(5)}` : 'Not geocoded yet'}</p>
      <div class="btnrow">
        <button class="btn outline" id="f-geocode">${icon('globe')} Geocode</button>
        <button class="btn primary" id="f-save">Save</button>
      </div>
      <div class="btnrow">
        ${stop.id ? '<button class="btn danger outline" id="f-delete">Delete stop</button>' : ''}
        <button class="btn outline" id="f-cancel">Cancel</button>
      </div>
      <p id="f-status-msg" class="muted"></p>
    </div>`;
  document.body.appendChild(overlay);

  const v = (id) => overlay.querySelector(`#${id}`).value.trim() || null;
  const msg = overlay.querySelector('#f-status-msg');

  function collect() {
    return {
      ...stop,
      address: v('f-address') || '',
      box: v('f-box'), slotSize: v('f-slot'), loadOrder: v('f-load'),
      routeStop: overlay.querySelector('#f-routestop').checked,
      boxesServed: (v('f-served') || '').split(',').map((s) => s.trim()).filter(Boolean),
      anchor: v('f-anchor'), status: v('f-status') || 'active',
      hold: v('f-hold'), holdFrom: v('f-holdfrom'), holdUntil: v('f-holduntil'),
      forwardTo: v('f-fwd'), forwardFrom: v('f-fwdfrom'), forwardUntil: v('f-fwduntil'),
      checkName: v('f-check'), checkUntil: v('f-checkuntil'),
      notes: v('f-notes'),
    };
  }

  overlay.querySelector('#f-save').addEventListener('click', () => {
    const s = collect();
    if (!s.address) { msg.textContent = 'Address is required.'; return; }
    db.upsertStop(pid, s);
    overlay.remove();
    toast('Saved');
    rerender();
  });
  overlay.querySelector('#f-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#f-delete')?.addEventListener('click', () => {
    if (confirm('Delete this stop?')) { db.deleteStop(pid, stop.id); overlay.remove(); rerender(); }
  });
  overlay.querySelector('#f-geocode').addEventListener('click', async () => {
    msg.textContent = 'Geocoding…';
    try {
      const g = await geocode(v('f-address') || '');
      stop.lat = g.lat; stop.lon = g.lon; stop.placeId = g.placeId; stop.geocodeType = g.geocodeType;
      msg.textContent = `Pinned: ${g.lat.toFixed(5)}, ${g.lon.toFixed(5)} — will be kept on Save.`;
    } catch (e) { msg.textContent = `Geocode failed: ${e.message}`; }
  });
}
