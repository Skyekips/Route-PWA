// Settings: API key, city hint, load-group size, profiles, and the xlsx bridge to the
// Android app (same file format both ways).

import * as db from './db.js';
import { importXlsx, exportXlsx } from './xlsxio.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderSettings(root, ctx) {
  const { pid, toast, rerender } = ctx;
  const profiles = db.getProfiles();

  root.innerHTML = `
    <header class="bar"><h1>Settings</h1></header>
    <div class="pad">
      <h3>Google Maps</h3>
      <label class="field"><span>API key (geocoding + road optimize)</span>
        <input class="input" id="apikey" type="password" value="${esc(db.getApiKey())}"/></label>
      <label class="field"><span>City / area hint</span>
        <input class="input" id="cityhint" value="${esc(db.getCityHint())}" placeholder="e.g. Nikiski, AK"/></label>

      <h3>Route</h3>
      <label class="field"><span>Load-order group size (stops per tray)</span>
        <input class="input" id="groupsize" type="number" min="1" max="200" value="${db.getGroupSize()}"/></label>

      <h3>Profiles</h3>
      <ul class="list" id="profiles">
        ${profiles.map((p) => `
          <li class="row ${p.id === pid ? 'current' : ''}">
            <button class="rowmain" data-switch="${esc(p.id)}">
              <span class="rowtext"><strong>${esc(p.name)}</strong>${p.id === pid ? '<small>active</small>' : ''}</span>
            </button>
            <button class="rowact" data-delprofile="${esc(p.id)}">✕</button>
          </li>`).join('')}
      </ul>
      <button class="btn outline" id="newprofile">＋ New profile</button>

      <h3>Data — moves between this and the Android app</h3>
      <div class="btnrow">
        <button class="btn outline" id="export">⬇ Export .xlsx</button>
        <label class="btn outline" for="importfile">⬆ Import .xlsx</label>
        <input type="file" id="importfile" accept=".xlsx" hidden/>
      </div>
      <p id="datamsg" class="muted"></p>
    </div>`;

  const save = () => {
    db.setApiKey(root.querySelector('#apikey').value.trim());
    db.setCityHint(root.querySelector('#cityhint').value.trim());
    db.setGroupSize(+root.querySelector('#groupsize').value || 20);
  };
  ['apikey', 'cityhint', 'groupsize'].forEach((id) =>
    root.querySelector(`#${id}`).addEventListener('change', () => { save(); toast('Saved'); }));

  root.querySelectorAll('[data-switch]').forEach((b) =>
    b.addEventListener('click', () => { db.setActiveProfileId(b.dataset.switch); rerender(); }));
  root.querySelectorAll('[data-delprofile]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = profiles.find((x) => x.id === b.dataset.delprofile);
      if (p && confirm(`Delete profile "${p.name}" and ALL its stops?`)) {
        db.deleteProfile(p.id); rerender();
      }
    }));
  root.querySelector('#newprofile').addEventListener('click', () => {
    const name = prompt('Profile name?');
    if (name) { db.createProfile(name.trim()); rerender(); }
  });

  const msg = root.querySelector('#datamsg');

  root.querySelector('#export').addEventListener('click', () => {
    const blob = exportXlsx(db.getStops(pid), db.getOfficial(pid));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Mail_Route_Database_${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  root.querySelector('#importfile').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    if (db.getStops(pid).length &&
        !confirm(`Importing replaces the ${db.getStops(pid).length} stops in this profile. Continue?`)) return;
    try {
      const { stops, official } = importXlsx(await file.arrayBuffer());
      db.setStops(pid, stops);
      if (official) db.setOfficial(pid, official); else db.clearOfficial(pid);
      msg.textContent = `Imported ${stops.length} stops${official ? ' + official route' : ''}.`;
      toast('Import complete');
    } catch (e) { msg.textContent = `Import failed: ${e.message}`; }
  });
}
