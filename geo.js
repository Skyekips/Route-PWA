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
  const ungeo = stops.filter((s) => s.lat == null || s.lon == null);
  return route.concat(ungeo);
}

// Road optimize via DirectionsService (optimizeWaypoints). Origin = first stop, dest = last.
export async function optimizeByRoad(stops) {
  const geo = stops.filter((s) => s.lat != null && s.lon != null);
  if (geo.length < 3) throw new Error('Need at least 3 located stops.');
  if (geo.length > 25) throw new Error('Road optimize handles up to 25 stops per call.');
  const maps = await loadMaps();
  const svc = new maps.DirectionsService();
  const origin = geo[0], destination = geo[geo.length - 1];
  const waypoints = geo.slice(1, -1).map((s) => ({ location: { lat: s.lat, lng: s.lon }, stopover: true }));
  const res = await svc.route({
    origin: { lat: origin.lat, lng: origin.lon },
    destination: { lat: destination.lat, lng: destination.lon },
    waypoints,
    optimizeWaypoints: true,
    travelMode: maps.TravelMode.DRIVING,
  });
  const order = res.routes[0].waypoint_order; // permutation of the middle waypoints
  const ordered = [geo[0], ...order.map((i) => geo[i + 1]), geo[geo.length - 1]];
  const path = res.routes[0].overview_path.map((p) => [p.lat(), p.lng()]);
  const ungeo = stops.filter((s) => s.lat == null || s.lon == null);
  return { order: ordered.concat(ungeo), polyline: path };
}
