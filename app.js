// Route PWA — app shell. Fresh rebuild mirroring the Android app: same data model (db.js),
// same ordering/alert logic (logic.js), same xlsx exchange format (xlsxio.js).
// Views live in view-*.js; each exports render(root, ctx) and reads db directly.

import * as db from './db.js';
import { renderDrive } from './view-drive.js';
import { renderToday } from './view-today.js';
import { renderStops } from './view-stops.js';
import { renderPlan } from './view-plan.js';
import { renderSettings } from './view-settings.js';

const TABS = [
  ['drive', 'Drive', '🚚'],
  ['today', 'Today', '📦'],
  ['stops', 'Stops', '📍'],
  ['plan', 'Plan', '🗺️'],
  ['settings', 'Settings', '⚙️'],
];

const state = {
  tab: location.hash.replace('#', '') || 'today',
};

export function navigate(tab) {
  state.tab = tab;
  location.hash = tab;
  render();
}

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2400);
}

/** Ensure a profile exists (first launch) and return its id. */
function ensureProfile() {
  let pid = db.getActiveProfileId();
  if (!pid) pid = db.createProfile('My Route');
  return pid;
}

export function render() {
  const root = document.getElementById('app');
  const pid = ensureProfile();
  const ctx = { pid, navigate, toast, rerender: render };

  root.innerHTML = `
    <main id="view"></main>
    <nav class="tabbar">
      ${TABS.map(([id, label, icon]) => `
        <button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">
          <span class="tab-icon">${icon}</span><span>${label}</span>
        </button>`).join('')}
    </nav>`;

  root.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => navigate(b.dataset.tab)));

  const view = root.querySelector('#view');
  switch (state.tab) {
    case 'drive': renderDrive(view, ctx); break;
    case 'stops': renderStops(view, ctx); break;
    case 'plan': renderPlan(view, ctx); break;
    case 'settings': renderSettings(view, ctx); break;
    default: renderToday(view, ctx);
  }
}

window.addEventListener('hashchange', () => {
  const tab = location.hash.replace('#', '');
  if (tab && tab !== state.tab && TABS.some(([id]) => id === tab)) { state.tab = tab; render(); }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();
