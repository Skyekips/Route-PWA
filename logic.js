// Ported Android logic (util/HoldStatus, ClusterAlerts, LoadOrder, RouteBuilder, RoadDistance,
// DeliveryOrder) so the PWA orders and alerts exactly like the app.
import { haversine } from './geo.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

// ── Hold/forward/check active windows (dates are "YYYY-MM-DD", lexicographic) ──
const within = (today, from, until) => !((from && today < from) || (until && today >= until));
export const activeHold = (s, today = todayStr()) =>
  s.hold && within(today, s.holdFrom, s.holdUntil) ? s.hold : null;
export const activeForward = (s, today = todayStr()) =>
  s.forwardTo && within(today, s.forwardFrom, s.forwardUntil) ? s.forwardTo : null;
export const activeCheck = (s, today = todayStr()) =>
  s.checkName && within(today, null, s.checkUntil) ? s.checkName : null;

// ── Cluster alerts: a box stop aggregates the flags of the addresses it serves ──
export function clusterAlerts(cur, allStops, handledKeys, packages) {
  const handled = new Set(handledKeys || []);
  const isBoxStop = cur.routeStop || (cur.boxesServed || []).length > 0;
  let related;
  if (isBoxStop) {
    const boxKeys = new Set([...(cur.box ? [cur.box] : []), ...(cur.boxesServed || [])]);
    related = allStops.filter((s) => s.id === cur.id || (s.box && boxKeys.has(s.box)));
  } else {
    related = [cur];
  }
  const alerts = [];
  for (const s of related) {
    const box = s.box || null;
    const hold = activeHold(s);
    if (hold) alerts.push({ stopId: s.id, key: `${s.id}-HOLD`, type: 'HOLD', address: s.address, detail: hold, until: s.holdUntil, box });
    const fwd = activeForward(s);
    if (fwd) alerts.push({ stopId: s.id, key: `${s.id}-FORWARD`, type: 'FORWARD', address: s.address, detail: fwd, until: s.forwardUntil, box });
    const chk = activeCheck(s);
    if (chk) alerts.push({ stopId: s.id, key: `${s.id}-CHECK`, type: 'CHECK', address: s.address, detail: chk, until: s.checkUntil, box });
    const pkg = packages?.[s.id];
    if (pkg?.clusterBox && pkg.packageCount > 0)
      alerts.push({ stopId: s.id, key: `${s.id}-LOCKER`, type: 'LOCKER', address: s.address, detail: box || '', until: null, box, count: pkg.packageCount });
    if (pkg?.lockerCandidateCount > 0)
      alerts.push({ stopId: s.id, key: `${s.id}-LOCKERCAND`, type: 'LOCKER_CANDIDATE', address: s.address, detail: box || '', until: null, box, count: pkg.lockerCandidateCount });
  }
  for (const a of alerts) a.handled = handled.has(a.key);
  return alerts.sort((a, b) => Number(a.handled) - Number(b.handled));   // unhandled first
}

export function alertLabel(a) {
  const n = a.count > 1 ? ` ×${a.count}` : '';
  const boxNote = a.detail ? ` (Box ${a.detail})` : '';
  switch (a.type) {
    case 'HOLD': return `Hold: ${a.detail} — ${a.address}`;
    case 'FORWARD': return `Fwd: ${a.detail} — ${a.address}`;
    case 'CHECK': return `Check for ${a.detail} — ${a.address}`;
    case 'LOCKER': return `Locker${n}${boxNote} — ${a.address}`;
    default: return `Locker candidate${n}${boxNote} — ${a.address}`;
  }
}

// ── Load-order groups ("group.position"; all of group N before any of N+1) ──
export const loadGroup = (s) => {
  const g = parseInt(String(s.loadOrder ?? '').split('.')[0], 10);
  return Number.isFinite(g) ? g : null;
};
export const loadOrderNum = (s) => {
  const n = parseInt(String(s.loadOrder ?? '').split('.')[0], 10);
  return Number.isFinite(n) ? n : Infinity;
};

/** stopId → "g.p" for the given order (anchors skipped), new group every groupSize stops. */
export function generateLoadOrder(ordered, groupSize) {
  const size = Math.max(1, groupSize | 0);
  const map = {};
  ordered.filter((s) => !s.anchor).forEach((s, i) => {
    map[s.id] = `${Math.floor(i / size) + 1}.${(i % size) + 1}`;
  });
  return map;
}

/** Enforce group precedence: stable-sort grouped stops in their own slots; report violations. */
export function enforceLoadOrder(proposed) {
  const slots = [];
  proposed.forEach((s, i) => { if (!s.anchor && loadGroup(s) != null) slots.push(i); });
  if (slots.length < 2) return { order: proposed, violations: [] };
  const grouped = slots.map((i) => proposed[i]);

  const violations = [];
  let maxSeen = -Infinity;
  for (const s of grouped) {
    const g = loadGroup(s);
    if (g < maxSeen) violations.push({ stop: s, group: g, conflictsWithGroup: maxSeen });
    else maxSeen = g;
  }
  if (!violations.length) return { order: proposed, violations: [] };

  const sorted = grouped.map((s, i) => [s, i])                 // stable sort by group
    .sort((a, b) => (loadGroup(a[0]) - loadGroup(b[0])) || (a[1] - b[1]))
    .map((p) => p[0]);
  const fixed = proposed.slice();
  slots.forEach((idx, i) => { fixed[idx] = sorted[i]; });
  return { order: fixed, violations };
}

// ── Road distance along the saved backbone polyline ─────────────────────────
/** line = [[lat, lon], ...]. Distances in meters; stops >400 m off the road → null (fallback). */
export function makeRoadDistance(line) {
  if (!line || line.length < 2) return null;
  const cum = new Array(line.length).fill(0);
  for (let i = 1; i < line.length; i++)
    cum[i] = cum[i - 1] + haversine(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
  const cache = new Map();

  function project(lat, lon) {
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let bestT = 0, bestD2 = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const ax = line[i][1] * cosLat, ay = line[i][0];
      const bx = line[i + 1][1] * cosLat, by = line[i + 1][0];
      const px = lon * cosLat, py = lat;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const f = len2 <= 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = px - (ax + f * dx), ey = py - (ay + f * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 < bestD2) { bestD2 = d2; bestT = cum[i] + (cum[i + 1] - cum[i]) * f; }
    }
    return { t: bestT, off: Math.sqrt(bestD2) * 111320 };   // degree-space → meters
  }

  function projectStop(s) {
    if (s.lat == null || s.lon == null) return null;
    if (!cache.has(s.id)) {
      const p = project(s.lat, s.lon);
      cache.set(s.id, p.off <= 400 ? p : null);
    }
    return cache.get(s.id);
  }

  return (a, b) => {
    const pa = projectStop(a), pb = projectStop(b);
    if (!pa || !pb) return null;
    return Math.abs(pa.t - pb.t) + pa.off + pb.off;
  };
}

// ── RouteBuilder: backbone in official order + packages into cheapest gaps ──
export function backboneWithInsertions(pool, officialOrder, roadLine) {
  const road = makeRoadDistance(roadLine);
  const start = pool.find((s) => s.anchor === 'start') || null;
  const finish = pool.find((s) => s.anchor === 'finish') || null;
  const nonAnchor = pool.filter((s) => !s.anchor);
  const rank = new Map((officialOrder || []).map((id, i) => [id, i]));

  let backbone = nonAnchor.filter((s) => s.routeStop).sort((a, b) =>
    ((rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity)) ||
    (loadOrderNum(a) - loadOrderNum(b)) ||
    String(a.address).localeCompare(String(b.address)));
  backbone = enforceLoadOrder(backbone).order;               // groups are law

  const packages = nonAnchor.filter((s) => !s.routeStop);
  const seq = [];
  if (start) seq.push(start);
  seq.push(...backbone);
  if (finish) seq.push(finish);

  const d = (a, b) => {
    if (a?.lat == null || a?.lon == null || b?.lat == null || b?.lon == null) return 0;
    const r = road ? road(a, b) : null;
    return r != null ? r : haversine(a.lat, a.lon, b.lat, b.lon);
  };
  const lo = start ? 1 : 0;
  for (const pkg of packages) {
    const hi = seq.length - (finish ? 1 : 0);
    if (pkg.lat == null || pkg.lon == null) { seq.splice(hi, 0, pkg); continue; }
    let bestPos = hi, bestCost = Infinity;
    for (let pos = lo; pos <= hi; pos++) {
      const prev = seq[pos - 1] || null, next = seq[pos] || null;
      const cost = d(prev, pkg) + d(pkg, next) - d(prev, next);
      if (cost < bestCost) { bestCost = cost; bestPos = pos; }
    }
    seq.splice(bestPos, 0, pkg);
  }
  return seq;
}

// ── Delivery order (mirrors Android DeliveryOrder.build) ────────────────────
export function deliveryOrder(stops, packages, officialOrder, completed, todayOrder, roadLine) {
  const done = new Set(completed || []);
  const hasPkg = (s) => (packages?.[s.id]?.packageCount || 0) > 0;
  const pool = stops.filter((s) => s.routeStop || s.anchor || hasPkg(s));

  let ordered;
  if (todayOrder) {
    const rank = new Map(todayOrder.map((id, i) => [id, i]));
    ordered = pool.slice().sort((a, b) =>
      ((a.anchor === 'start' ? 0 : a.anchor === 'finish' ? 2 : 1) -
       (b.anchor === 'start' ? 0 : b.anchor === 'finish' ? 2 : 1)) ||
      ((rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity)) ||
      (loadOrderNum(a) - loadOrderNum(b)) ||
      String(a.address).localeCompare(String(b.address)));
  } else if (officialOrder) {
    ordered = backboneWithInsertions(pool, officialOrder, roadLine);
  } else {
    ordered = pool.slice().sort((a, b) =>
      ((a.anchor === 'start' ? 0 : a.anchor === 'finish' ? 2 : 1) -
       (b.anchor === 'start' ? 0 : b.anchor === 'finish' ? 2 : 1)) ||
      (loadOrderNum(a) - loadOrderNum(b)) ||
      String(a.address).localeCompare(String(b.address)));
  }
  return ordered.filter((s) => !done.has(s.id));
}
