// Scanner overlay: camera + Tesseract OCR + the two-tier address matcher. Carries over the
// hard-won diagnostics from the old app: secure-context guard, specific camera errors,
// load progress, and a live "Reading: …" readout so aiming problems are visible.

import * as db from './db.js';
import { icon } from './icons.js';
import { findMatches, findFuzzyMatches } from './fuzzy.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openScanner(ctx) {
  const { pid, toast, rerender } = ctx;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="scanner">
      <video id="cam" playsinline muted></video>
      <p id="scanstatus">Starting camera…</p>
      <div id="scanmatches"></div>
      <button class="btn outline" id="closescan">Close</button>
    </div>`;
  document.body.appendChild(overlay);

  const video = overlay.querySelector('#cam');
  const status = overlay.querySelector('#scanstatus');
  const matchBox = overlay.querySelector('#scanmatches');
  const st = { alive: true, stream: null, worker: null, busy: false, locked: false, firstSeen: 0 };

  function close() {
    st.alive = false;
    st.stream?.getTracks().forEach((tr) => tr.stop());
    st.worker?.terminate();
    overlay.remove();
    rerender();
  }
  overlay.querySelector('#closescan').addEventListener('click', close);

  function showMatches(found) {
    matchBox.innerHTML = found.slice(0, 3).map((s) => `
      <div class="scanmatch">
        <strong>${esc(s.address)}</strong>${s.box ? ` <small>Box ${esc(s.box)}</small>` : ''}
        <div class="btnrow">
          <button class="btn primary" data-add="${s.id}">${icon('add')} Package</button>
          <button class="btn outline" data-locker="${s.id}">${icon('box')} Locker</button>
          <button class="btn outline" data-cand="${s.id}">Candidate</button>
          <button class="btn outline" data-writeup="${s.id}">Write-up</button>
        </div>
      </div>`).join('') +
      `<button class="btn outline" id="rescan">${icon('refresh')} Keep scanning</button>`;
    matchBox.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      db.addPackage(pid, +b.dataset.add); toast('Package added'); resume();
    }));
    matchBox.querySelectorAll('[data-locker]').forEach((b) => b.addEventListener('click', () => {
      db.addPackage(pid, +b.dataset.locker, true); toast('Locker package added'); resume();
    }));
    matchBox.querySelectorAll('[data-cand]').forEach((b) => b.addEventListener('click', () => {
      db.addPackage(pid, +b.dataset.cand, false, false, true); toast('Locker candidate noted'); resume();
    }));
    matchBox.querySelectorAll('[data-writeup]').forEach((b) => b.addEventListener('click', () => {
      db.addPackage(pid, +b.dataset.writeup, false, true); toast('Write-up recorded'); resume();
    }));
    matchBox.querySelector('#rescan').addEventListener('click', resume);
  }

  function resume() {
    matchBox.innerHTML = '';
    st.locked = false;
    st.firstSeen = 0;
    status.textContent = 'Align address label in frame';
  }

  async function start() {
    // getUserMedia only exists in a secure context (https:// or localhost) — say so plainly.
    if (!navigator.mediaDevices?.getUserMedia) {
      status.textContent = location.protocol === 'https:'
        ? 'This browser has no camera API.'
        : `Camera needs a secure site — open Route over https:// (currently ${location.protocol}//).`;
      return;
    }
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      video.srcObject = st.stream;
      await video.play().catch(() => {});
    } catch (e) {
      status.textContent =
        e?.name === 'NotAllowedError' ? 'Camera blocked — allow camera access for this site, then reopen Scan.'
        : e?.name === 'NotFoundError' ? 'No camera found on this device.'
        : `Camera error: ${e?.message || e?.name || e}`;
      return;
    }
    if (typeof Tesseract === 'undefined') {
      status.textContent = 'Scanner library didn’t load — check your connection, then reopen Scan.';
      return;
    }
    status.textContent = 'Loading scanner…';
    try {
      // ONE persistent worker; the logger turns the big language-data download into visible progress.
      st.worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (!st.alive || !m?.status || m.status.includes('recogniz')) return;
          const pct = m.progress != null ? ` ${Math.round(m.progress * 100)}%` : '';
          status.textContent = `Loading scanner… ${m.status}${pct}`;
        },
      });
    } catch (e) { status.textContent = `Scanner failed to start: ${e?.message || e}`; return; }
    if (!st.alive) { st.worker.terminate(); return; }
    status.textContent = 'Align address label in frame';
    tickLoop();
  }

  async function tickLoop() {
    while (st.alive) {
      if (!st.busy && !st.locked && video.videoWidth) await tick();
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  async function tick() {
    st.busy = true;
    try {
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = Math.floor(video.videoHeight * 0.5);
      c.getContext('2d').drawImage(video, 0, video.videoHeight * 0.25, c.width, c.height, 0, 0, c.width, c.height);
      const { data: { text } } = await st.worker.recognize(c);
      if (!st.alive || st.locked) return;
      const all = (text || '').replace(/\n/g, ' ').trim();
      if (!all) { status.textContent = 'Scanning… fill the strip with the address label'; return; }
      if (!st.firstSeen) st.firstSeen = Date.now();
      const candidates = db.getStops(pid).filter((s) => !s.routeStop && !s.anchor && s.address);
      // findMatches returns {stop, score} wrappers — unwrap before showing.
      let found = findMatches(all, candidates).map((m) => m.stop);
      if (!found.length && Date.now() - st.firstSeen > 1250)
        found = findFuzzyMatches(all, candidates).map((m) => m.stop);
      if (found.length) { st.locked = true; status.textContent = 'Match!'; showMatches(found); }
      else status.textContent = `Reading: “${all.slice(0, 30)}”`;
    } catch (e) { status.textContent = `Scan error: ${e?.message || e}`; }
    finally { st.busy = false; }
  }

  start();
}
