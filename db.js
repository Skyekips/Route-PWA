// Local storage data layer — mirrors the Android Room model so xlsx round-trips cleanly.
// Everything lives on the device (localStorage); no server.

const K = {
  profiles: 'route_profiles',
  active: 'route_active',
  apiKey: 'route_apikey',
  cityHint: 'route_cityhint',
  groupSize: 'route_groupsize',
  stops: (pid) => `route_stops_${pid}`,
  official: (pid) => `route_official_${pid}`,
  today: (pid) => `route_today_${pid}`,
  polyline: (pid) => `route_polyline_${pid}`,
};

const read = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let idSeq = read('route_idseq', Date.now());
export const newId = () => { idSeq += 1; write('route_idseq', idSeq); return idSeq; };

// ── Settings ────────────────────────────────────────────────────────────────
export const getApiKey = () => read(K.apiKey, '') || '';
export const setApiKey = (v) => write(K.apiKey, v || '');
export const getCityHint = () => read(K.cityHint, '') || '';
export const setCityHint = (v) => write(K.cityHint, v || '');
export const getGroupSize = () => { const n = read(K.groupSize, 20); return Number.isFinite(+n) && +n >= 1 ? Math.min(200, +n) : 20; };
export const setGroupSize = (v) => write(K.groupSize, Math.min(200, Math.max(1, v | 0)));

// ── Profiles ────────────────────────────────────────────────────────────────
export const getProfiles = () => read(K.profiles, []);
export const getActiveProfileId = () => {
  const id = read(K.active, null);
  const list = getProfiles();
  if (list.some((p) => p.id === id)) return id;
  return list[0]?.id ?? null;
};
export const setActiveProfileId = (id) => write(K.active, id);
export function createProfile(name) {
  const id = `p_${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}`;
  const list = getProfiles();
  list.push({ id, name, createdAt: Date.now() });
  write(K.profiles, list);
  setActiveProfileId(id);
  return id;
}
export function renameProfile(id, name) {
  const list = getProfiles().map((p) => (p.id === id ? { ...p, name } : p));
  write(K.profiles, list);
}
export function deleteProfile(id) {
  write(K.profiles, getProfiles().filter((p) => p.id !== id));
  localStorage.removeItem(K.stops(id));
  localStorage.removeItem(K.official(id));
  localStorage.removeItem(K.today(id));
  if (getActiveProfileId() === id) setActiveProfileId(getProfiles()[0]?.id ?? null);
}
export const getProfile = (id) => getProfiles().find((p) => p.id === id) || null;

// ── Stops ───────────────────────────────────────────────────────────────────
export const STOP_DEFAULTS = {
  address: '', stop: null, box: null, status: 'active', slotSize: null, loadOrder: null,
  hold: null, holdFrom: null, holdUntil: null,
  forwardTo: null, forwardFrom: null, forwardUntil: null,
  checkName: null, checkUntil: null,   // verify-this-person-lives-here reminder (device-local)
  notes: null, lat: null, lon: null, placeId: null, geocodeQuality: null, geocodeType: null,
  anchor: null, routeStop: false, boxesServed: [], boxSlotIndex: null, navigateByPin: false,
};

export const getStops = (pid) => read(K.stops(pid), []);
export const setStops = (pid, stops) => write(K.stops(pid), stops);
export function upsertStop(pid, stop) {
  const stops = getStops(pid);
  if (stop.id) {
    const i = stops.findIndex((s) => s.id === stop.id);
    if (i >= 0) stops[i] = stop; else stops.push(stop);
  } else {
    stop.id = newId();
    stops.push(stop);
  }
  setStops(pid, stops);
  return stop.id;
}
export function deleteStop(pid, id) {
  setStops(pid, getStops(pid).filter((s) => s.id !== id));
}
export const getStop = (pid, id) => getStops(pid).find((s) => s.id === id) || null;

// ── Official route ──────────────────────────────────────────────────────────
export const getOfficial = (pid) => read(K.official(pid), null);
export const setOfficial = (pid, ids) => write(K.official(pid), ids);
export const clearOfficial = (pid) => localStorage.removeItem(K.official(pid));

// ── Today (packages / completed / staged order / handled alerts) ─────────────
const emptyToday = () => ({ packages: {}, completed: [], order: null, handledAlerts: [] });
export const getToday = (pid) => ({ ...emptyToday(), ...read(K.today(pid), {}) });
export const setToday = (pid, t) => write(K.today(pid), t);

export function addPackage(pid, stopId, clusterBox = false, writeUp = false, lockerCandidate = false) {
  const t = getToday(pid);
  const cur = t.packages[stopId] || { packageCount: 0, writeUpCount: 0, lockerCandidateCount: 0, clusterBox: false };
  if (writeUp) {
    // Writing up converts every parcel already scanned here into a write-up.
    cur.writeUpCount = (cur.writeUpCount || 0) + (cur.packageCount || 0) + 1;
    cur.packageCount = 0;
  } else if (lockerCandidate) {
    cur.lockerCandidateCount = (cur.lockerCandidateCount || 0) + 1;  // noted, not a delivery
  } else {
    cur.packageCount = (cur.packageCount || 0) + 1;
  }
  if (clusterBox) cur.clusterBox = true;
  t.packages[stopId] = cur;
  setToday(pid, t);
  return cur;
}
export function removePackage(pid, stopId) {
  const t = getToday(pid);
  delete t.packages[stopId];
  setToday(pid, t);
}
export function setTodayOrder(pid, ids) { const t = getToday(pid); t.order = ids; setToday(pid, t); }
export function markCompleted(pid, stopId, done = true) {
  const t = getToday(pid);
  const set = new Set(t.completed);
  if (done) set.add(stopId); else set.delete(stopId);
  t.completed = [...set];
  setToday(pid, t);
}
export function clearToday(pid) { setToday(pid, emptyToday()); }
export function setAlertHandled(pid, key, handled = true) {
  const t = getToday(pid);
  const set = new Set(t.handledAlerts || []);
  if (handled) set.add(key); else set.delete(key);
  t.handledAlerts = [...set];
  setToday(pid, t);
}
export function clearLockerFlag(pid, stopId) {
  const t = getToday(pid);
  if (t.packages[stopId]) { t.packages[stopId].clusterBox = false; setToday(pid, t); }
}

// ── Backbone road polyline (from road-optimize) → road-aware package insertion ──
export const getRoadPolyline = (pid) => read(K.polyline(pid), null);   // [[lat,lon], ...] or null
export const setRoadPolyline = (pid, line) => write(K.polyline(pid), line);
