// Geocoding + route optimization via the Google Maps JavaScript API (loaded with the user's key).
// Using the JS API avoids the browser CORS wall that blocks Google's REST endpoints.
import { getApiKey, getCityHint } from './db.js';

let mapsPromise = null;
export function loadMaps() {
  if (mapsPromise) return mapsPromise;
  const key = getApiKey().trim();
  if (!key) return Promise.reject(new Error('No API key — add one in Settings.'));
  mapsPromise = new Promise((resolve, reject) => {
    if (window.google?.maps) { resolve(window.google.maps); return; }
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry`;
    s.async = true;
    s.onload = () => (window.google?.maps ? resolve(window.google.maps) : reject(new Error('Maps failed to load')));
    s.onerror = () => { mapsPromise = null; reject(new Error('Maps failed to load (check the key)')); };
    document.head.appendChild(s);
  });
  return mapsPromise;
}

export async function geocode(address) {
  const maps = await loadMaps();
  const hint = getCityHint().trim();
  const query = hint && !address.toLowerCase().includes(hint.toLowerCase()) ? `${address}, ${hint}` : address;
  const geocoder = new maps.Geocoder();
  const { results } = await geocoder.geocode({ address: query });
  if (!results || !results.length) throw new Error('No result');
  const r = results[0];
  return {
    lat: r.geometry.location.lat(),
    lon: r.geometry.location.lng(),
    placeId: r.place_id,
    geocodeType: r.geometry.location_type,
  };
}

// Haversine metres
export function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Straight-line optimize: nearest-neighbour seed + 2-opt (free, offline). Keeps a "start" anchor first.
export function optimizeStraightLine(stops) {
  const geo = stops.filter((s) => s.lat != null && s.lon != null);
  if (geo.length < 3) return stops;
  const startIdx = Math.max(0, geo.findIndex((s) => s.anchor === 'start'));
  const used = new Array(geo.length).fill(false);
  const order = [startIdx]; used[startIdx] = true;
  for (let k = 1; k < geo.length; k++) {
    const last = geo[order[order.length - 1]];
    let best = -1, bestD = Infinity;
    for (let j = 0; j < geo.length; j++) {
      if (used[j]) continue;
      const d = haversine(last.lat, last.lon, geo[j].lat, geo[j].lon);
      if (d < bestD) { bestD = d; best = j; }
    }
    order.push(best); used[best] = true;
  }
  let route = order.map((i) => geo[i]);
  // 2-opt (open path — no wrap)
  const dist = (a, b) => haversine(a.lat, a.lon, b.lat, b.lon);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const a = route[i - 1], b = route[i], c = route[j], d = route[j + 1];
        const before = dist(a, b) + (d ? dist(c, d) : 0);
        const after = dist(a, c) + (d ? dist(b, d) : 0);
        if (after + 1e-6 < before) {
          route = route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
          improved = true;
        }
      }
    }
  }
  // Pin a finish anchor to the end (nearest-neighbour/2-opt can drift it into the middle).
  const fin = route.find((s) => s.anchor === 'finish');
  if (fin) { route = route.filter((s) => s !== fin); route.push(fin); }
  const ungeo = stops.filter((s) => s.lat == null || s.lon == null);
  return route.concat(ungeo);
}

// Road optimize via DirectionsService (optimizeWaypoints), ported from the Android RoadOptimizer:
// start/finish anchors are pinned as origin/destination, and routes beyond the 25-waypoint limit
// are optimized in chunks with fixed boundaries (polyline omitted for chunked runs).
export async function optimizeByRoad(stops) {
  const geo = stops.filter((s) => s.lat != null && s.lon != null);
  const ungeo = stops.filter((s) => s.lat == null || s.lon == null);
  if (geo.length < 3) throw new Error('Need at least 3 located stops.');
  const maps = await loadMaps();
  const svc = new maps.DirectionsService();

  const start = geo.find((s) => s.anchor === 'start');
  const finish = geo.find((s) => s.anchor === 'finish');
  const middle = geo.filter((s) => s.anchor !== 'start' && s.anchor !== 'finish');
  const origin = start || middle.shift();
  const destination = finish || middle.pop();

  async function call(o, d, inter) {
    const res = await svc.route({
      origin: { lat: o.lat, lng: o.lon },
      destination: { lat: d.lat, lng: d.lon },
      waypoints: inter.map((s) => ({ location: { lat: s.lat, lng: s.lon }, stopover: true })),
      optimizeWaypoints: true,
      travelMode: maps.TravelMode.DRIVING,
    });
    const r = res.routes[0];
    const perm = r.waypoint_order || inter.map((_, i) => i);
    return {
      order: perm.map((i) => inter[i]),
      path: r.overview_path.map((p) => [p.lat(), p.lng()]),
    };
  }

  const MAX = 23;   // DirectionsService caps waypoints at 25; keep margin
  if (middle.length <= MAX) {
    const { order, path } = await call(origin, destination, middle);
    return { order: [origin, ...order, destination, ...ungeo], polyline: path };
  }

  // Chunked: optimize each stretch between fixed boundary stops.
  const out = [origin];
  let prev = origin;
  const chunks = [];
  for (let i = 0; i < middle.length; i += MAX) chunks.push(middle.slice(i, i + MAX));
  for (let ci = 0; ci < chunks.length; ci++) {
    const isLast = ci === chunks.length - 1;
    const chunkDest = isLast ? destination : chunks[ci][chunks[ci].length - 1];
    const inter = isLast ? chunks[ci] : chunks[ci].slice(0, -1);
    const { order } = await call(prev, chunkDest, inter);
    out.push(...order);
    if (!isLast) { out.push(chunkDest); prev = chunkDest; }
  }
  out.push(destination);
  return { order: out.concat(ungeo), polyline: null };   // too long for one polyline call
}
