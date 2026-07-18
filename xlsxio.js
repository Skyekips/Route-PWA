// Import/export the same .xlsx layout the Android app uses, so routes move Android <-> iPhone.
// Relies on the SheetJS (XLSX) global loaded in index.html.
import { STOP_DEFAULTS, newId, newUid } from './db.js';

const COLUMNS = [
  'address', 'stop', 'box', 'status', 'slot_size', 'load_order',
  'hold', 'hold_from', 'hold_until', 'forward_to', 'forward_from', 'forward_until',
  'notes', 'lat', 'lon', 'place_id', 'geocode_quality', 'geocode_type',
  'anchor', 'route_stop', 'boxes_served', 'box_slot_index', 'navigate_by_pin', 'official_index',
  'check_name', 'check_until', 'uid', 'updated_at',
];

const bool = (v) => String(v).trim().toLowerCase() === 'true';
const numOrNull = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
const strOrNull = (v) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? null : s; };

/** Returns { stops, official } from an array buffer of an .xlsx file. */
export function importXlsx(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const stops = [];
  const officialPairs = [];
  for (const r of rows) {
    const address = strOrNull(r.address);
    if (!address) continue;
    const id = newId();
    const stop = {
      ...STOP_DEFAULTS,
      id,
      address,
      stop: strOrNull(r.stop),
      box: strOrNull(r.box),
      status: strOrNull(r.status) || 'active',
      slotSize: strOrNull(r.slot_size),
      loadOrder: strOrNull(r.load_order),
      hold: strOrNull(r.hold),
      holdFrom: strOrNull(r.hold_from),
      holdUntil: strOrNull(r.hold_until),
      forwardTo: strOrNull(r.forward_to),
      forwardFrom: strOrNull(r.forward_from),
      forwardUntil: strOrNull(r.forward_until),
      checkName: strOrNull(r.check_name),
      checkUntil: strOrNull(r.check_until),
      uid: strOrNull(r.uid) || newUid(),
      updatedAt: numOrNull(r.updated_at) || 0,
      notes: strOrNull(r.notes),
      lat: numOrNull(r.lat),
      lon: numOrNull(r.lon),
      placeId: strOrNull(r.place_id),
      geocodeQuality: strOrNull(r.geocode_quality),
      geocodeType: strOrNull(r.geocode_type),
      anchor: strOrNull(r.anchor),
      routeStop: bool(r.route_stop),
      boxesServed: strOrNull(r.boxes_served) ? String(r.boxes_served).split(',').map((s) => s.trim()).filter(Boolean) : [],
      boxSlotIndex: numOrNull(r.box_slot_index),
      navigateByPin: bool(r.navigate_by_pin),
    };
    stops.push(stop);
    const oi = numOrNull(r.official_index);
    if (oi != null) officialPairs.push([id, oi]);
  }
  const official = officialPairs.sort((a, b) => a[1] - b[1]).map((p) => p[0]);
  return { stops, official: official.length ? official : null };
}

/** Builds an .xlsx Blob from stops + official order. */
export function exportXlsx(stops, official) {
  const officialIndex = {};
  (official || []).forEach((id, i) => { officialIndex[id] = i; });
  const aoa = [COLUMNS];
  for (const s of stops) {
    aoa.push([
      s.address || '', s.stop || '', s.box || '', s.status || '', s.slotSize || '', s.loadOrder || '',
      s.hold || '', s.holdFrom || '', s.holdUntil || '',
      s.forwardTo || '', s.forwardFrom || '', s.forwardUntil || '',
      s.notes || '', s.lat ?? '', s.lon ?? '', s.placeId || '', s.geocodeQuality || '', s.geocodeType || '',
      s.anchor || '', s.routeStop ? 'true' : 'false',
      (s.boxesServed || []).join(','), s.boxSlotIndex ?? '', s.navigateByPin ? 'true' : 'false',
      officialIndex[s.id] ?? '', s.checkName || '', s.checkUntil || '', s.uid || '', s.updatedAt ?? 0,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Route');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
