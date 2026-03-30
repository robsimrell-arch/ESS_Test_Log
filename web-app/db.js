/**
 * Chamber Test Log – IndexedDB persistence via Dexie.js
 * All data stored locally in the browser.
 */
import Dexie from 'dexie';

// Unique device identifier (persists across sessions in this browser)
let DEVICE_ID = localStorage.getItem('ctl_device_id');
if (!DEVICE_ID) {
  DEVICE_ID = crypto.randomUUID();
  localStorage.setItem('ctl_device_id', DEVICE_ID);
}
export { DEVICE_ID };

const db = new Dexie('ChamberTestLog');

// v1 – original schema
db.version(1).stores({
  sessions:    '++id, operator, chamber, station, part_number, test_type, start_time, end_time, created_at, closed_by',
  uut_entries: '++id, session_id, channel, uut_serial, cable_serial, backplane, notes, failure_notes, result',
  config:      'key',
});

// v2 – add sync fields (uuid, sync_status, updated_at)
db.version(2).stores({
  sessions:    '++id, uuid, sync_status, operator, chamber, station, part_number, test_type, start_time, end_time, created_at, closed_by',
  uut_entries: '++id, uuid, sync_status, session_id, channel, uut_serial, cable_serial, backplane, notes, failure_notes, result',
  config:      'key',
}).upgrade(tx => {
  // Backfill existing records with sync fields
  tx.table('sessions').toCollection().modify(s => {
    if (!s.uuid) s.uuid = crypto.randomUUID();
    if (!s.sync_status) s.sync_status = 'pending';
    if (!s.updated_at)  s.updated_at = s.created_at || new Date().toISOString();
  });
  tx.table('uut_entries').toCollection().modify(e => {
    if (!e.uuid) e.uuid = crypto.randomUUID();
    if (!e.sync_status) e.sync_status = 'pending';
    if (!e.updated_at)  e.updated_at = new Date().toISOString();
  });
});

/* ── Config helpers ───────────────────────────────────────────────────── */
const DEFAULT_CONFIG = {
  part_numbers:  [],
  chambers:      ['CH-01', 'CH-02', 'CH-03', 'CH-04'],
  test_stations: ['TS-01', 'TS-02', 'TS-03', 'TS-04'],
  // chamber_part_matrix: { 'CH-01': ['PN-A', 'PN-B'], ... }
  // A chamber with NO entry (or an empty array) accepts all parts.
  chamber_part_matrix: {},
};

export async function loadConfig() {
  const row = await db.config.get('settings');
  if (row) return row.value;
  // Initialize default without marking it as a new edit to be pushed.
  // Use a very old timestamp so any Supabase config will reliably overwrite this default on the first pull.
  await db.config.put({ key: 'settings', value: { ...DEFAULT_CONFIG }, sync_status: 'synced', updated_at: '2000-01-01T00:00:00.000Z' });
  return { ...DEFAULT_CONFIG };
}

export async function saveConfig(cfg) {
  await db.config.put({ key: 'settings', value: cfg, sync_status: 'pending', updated_at: new Date().toISOString() });
}

/* ── Session CRUD ─────────────────────────────────────────────────────── */
export async function dbNewSession(operator, chamber, station, pn, tt) {
  return db.sessions.add({
    uuid: crypto.randomUUID(),
    device_id: DEVICE_ID,
    operator, chamber, station,
    part_number: pn, test_type: tt,
    start_time: null, end_time: null,
    created_at: new Date().toISOString(),
    closed_by: '',
    sync_status: 'pending',
    updated_at: new Date().toISOString(),
  });
}

export async function dbSetStart(sid, iso) {
  return db.sessions.update(sid, { start_time: iso, sync_status: 'pending', updated_at: new Date().toISOString() });
}

export async function dbSetEnd(sid, iso, closedBy = '') {
  return db.sessions.update(sid, { end_time: iso, closed_by: closedBy, sync_status: 'pending', updated_at: new Date().toISOString() });
}

export async function dbSaveEntries(sid, rows) {
  const existingRows = await db.uut_entries.where('session_id').equals(sid).toArray();
  const existingMap = {};
  for (const r of existingRows) {
    if (!existingMap[r.channel] || (r.updated_at && existingMap[r.channel].updated_at && r.updated_at > existingMap[r.channel].updated_at)) {
      existingMap[r.channel] = r;
    }
  }

  const now = new Date().toISOString();
  const upserts = [];

  for (const r of rows) {
    const hasData = r.uut_serial || r.cable_serial;
    const existing = existingMap[r.channel];

    if (hasData) {
      if (existing) {
        upserts.push({ ...existing, ...r, sync_status: 'pending', updated_at: now });
      } else {
        upserts.push({ ...r, session_id: sid, uuid: crypto.randomUUID(), sync_status: 'pending', updated_at: now });
      }
    } else if (existing) {
      upserts.push({
        ...existing,
        uut_serial: '', cable_serial: '', backplane: '', notes: '', failure_notes: '', result: '',
        sync_status: 'pending', updated_at: now
      });
    }
  }

  if (upserts.length) await db.uut_entries.bulkPut(upserts);
  await db.sessions.update(sid, { sync_status: 'pending', updated_at: now });
}

export async function dbAllSessions() {
  return (await db.sessions.orderBy('id').reverse().toArray());
}

export async function dbSessionEntries(sid) {
  const entries = await db.uut_entries.where('session_id').equals(sid).toArray();
  const latestByChan = new Map();
  for (const e of entries) {
    const existing = latestByChan.get(e.channel);
    if (!existing || (e.updated_at && existing.updated_at && e.updated_at > existing.updated_at)) {
      latestByChan.set(e.channel, e);
    }
  }
  return Array.from(latestByChan.values()).sort((a, b) => a.channel - b.channel);
}

export async function dbDistinct(col) {
  const all = await db.sessions.toArray();
  return [...new Set(all.map(s => s[col]).filter(Boolean))].sort();
}

/**
 * All UUT entries joined with session data, sorted chronologically.
 */
export async function dbAllTests() {
  const sessions = await db.sessions.toArray();
  const sMap = Object.fromEntries(sessions.map(s => [s.id, s]));
  const entries = await db.uut_entries.toArray();

  const latestBySessionChannel = new Map();
  for (const e of entries) {
    const key = `${e.session_id}_${e.channel}`;
    const existing = latestBySessionChannel.get(key);
    if (!existing || (e.updated_at && existing.updated_at && e.updated_at > existing.updated_at)) {
      latestBySessionChannel.set(key, e);
    }
  }

  const joined = Array.from(latestBySessionChannel.values())
    .filter(e => e.uut_serial)
    .map(e => {
      const s = sMap[e.session_id];
      if (!s) return null;
      return {
        start_time:    s.start_time,
        sid:           s.id,
        operator:      s.operator,
        closed_by:     s.closed_by || '',
        chamber:       s.chamber,
        station:       s.station,
        part_number:   s.part_number,
        test_type:     s.test_type,
        channel:       e.channel,
        uut_serial:    e.uut_serial,
        cable_serial:  e.cable_serial || '',
        backplane:     e.backplane || '',
        notes:         e.notes || '',
        failure_notes: e.failure_notes || '',
        result:        e.result || '',
        end_time:      s.end_time,
      };
    })
    .filter(Boolean);
  joined.sort((a, b) => {
    const cmp = (a.start_time || '').localeCompare(b.start_time || '');
    if (cmp !== 0) return cmp;
    if (a.sid !== b.sid) return a.sid - b.sid;
    return a.channel - b.channel;
  });
  return joined;
}

export async function dbGetOpenSessions() {
  // Return all sessions that haven't been ended, regardless of device.
  // This shows all active sessions across all machines in the minimized bar.
  return db.sessions.filter(s => {
    return s.end_time === null || s.end_time === '';
  }).toArray();
}

export async function dbSearchUut(serial) {
  const lc = serial.toLowerCase();
  const entries = await db.uut_entries.toArray();
  const matching = entries.filter(e => e.uut_serial && e.uut_serial.toLowerCase().includes(lc));
  if (!matching.length) return [];
  const sidSet = new Set(matching.map(e => e.session_id));
  const sessions = await db.sessions.toArray();
  const sMap = Object.fromEntries(sessions.map(s => [s.id, s]));
  return matching.map(e => {
    const s = sMap[e.session_id];
    if (!s) return null;
    return {
      session_id:    s.id,
      operator:      s.operator,
      chamber:       s.chamber,
      station:       s.station,
      part_number:   s.part_number,
      test_type:     s.test_type,
      start_time:    s.start_time,
      end_time:      s.end_time,
      channel:       e.channel,
      cable_serial:  e.cable_serial || '',
      backplane:     e.backplane || '',
      notes:         e.notes || '',
      failure_notes: e.failure_notes || '',
      result:        e.result || '',
    };
  }).filter(Boolean).sort((a,b) => (b.start_time||'').localeCompare(a.start_time||''));
}

/* ── Full DB Export / Import ──────────────────────────────────────────── */

/**
 * Export the entire database as a single JSON object.
 * Includes sessions, uut_entries, and config.
 */
export async function dbExportAll() {
  const sessions   = await db.sessions.toArray();
  const entries    = await db.uut_entries.toArray();
  const cfgRow     = await db.config.get('settings');
  return {
    _format:      'ChamberTestLog_Export',
    _version:     1,
    _exportedAt:  new Date().toISOString(),
    config:       cfgRow ? cfgRow.value : null,
    sessions,
    uut_entries:  entries,
  };
}

/**
 * Import a previously exported JSON blob.
 *
 * @param {object}  data        – The parsed JSON export object.
 * @param {'merge'|'replace'} mode
 *   - 'replace': wipe all existing data first, then load the export.
 *   - 'merge':   keep existing data, add imported sessions with remapped IDs.
 * @returns {{ sessions: number, entries: number }} counts of imported records.
 */
export async function dbImportAll(data, mode = 'merge') {
  if (data._format !== 'ChamberTestLog_Export') {
    throw new Error('Invalid file format – not a Chamber Test Log export.');
  }

  if (mode === 'replace') {
    await db.sessions.clear();
    await db.uut_entries.clear();
  }

  // Config: always overwrite with imported config if present
  if (data.config) {
    await db.config.put({ key: 'settings', value: data.config });
  }

  // Build an ID remap: old session ID → new session ID
  const idMap = {};
  let sessCount = 0;
  for (const s of (data.sessions || [])) {
    const oldId = s.id;
    // Remove the auto-increment id so Dexie assigns a fresh one
    const { id, ...rest } = s;
    const newId = await db.sessions.add(rest);
    idMap[oldId] = newId;
    sessCount++;
  }

  // Import UUT entries with remapped session_id
  let entryCount = 0;
  const entriesToAdd = [];
  for (const e of (data.uut_entries || [])) {
    const { id, session_id, ...rest } = e;
    const mappedSid = idMap[session_id];
    if (mappedSid == null) continue; // skip orphans
    entriesToAdd.push({ ...rest, session_id: mappedSid });
    entryCount++;
  }
  if (entriesToAdd.length) {
    await db.uut_entries.bulkAdd(entriesToAdd);
  }

  return { sessions: sessCount, entries: entryCount };
}

/* ── Utility ──────────────────────────────────────────────────────────── */
export function fmtTs(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch { return iso; }
}

export default db;
