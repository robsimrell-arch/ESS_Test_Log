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
  max_full_tests: 1,
  max_mini_tests: 2,
};

export async function loadConfig() {
  const row = await db.config.get('settings');
  if (row && row.value) {
    const val = { ...row.value };
    if (val.max_full_tests === undefined) val.max_full_tests = 1;
    if (val.max_mini_tests === undefined) val.max_mini_tests = 2;
    return val;
  }
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
  let hasChanges = false;

  for (const r of rows) {
    const hasData = r.uut_serial || r.cable_serial;
    const existing = existingMap[r.channel];

    if (hasData) {
      if (existing) {
        const isUnchanged =
          (existing.uut_serial || '') === (r.uut_serial || '') &&
          (existing.cable_serial || '') === (r.cable_serial || '') &&
          (existing.backplane || '') === (r.backplane || '') &&
          (existing.notes || '') === (r.notes || '') &&
          (existing.failure_notes || '') === (r.failure_notes || '') &&
          (existing.result || '') === (r.result || '');

        if (!isUnchanged) {
          upserts.push({ ...existing, ...r, sync_status: 'pending', updated_at: now });
          hasChanges = true;
        }
      } else {
        upserts.push({ ...r, session_id: sid, uuid: crypto.randomUUID(), sync_status: 'pending', updated_at: now });
        hasChanges = true;
      }
    } else if (existing) {
      const isAlreadyBlank =
        !existing.uut_serial && !existing.cable_serial && !existing.backplane &&
        !existing.notes && !existing.failure_notes && !existing.result;

      if (!isAlreadyBlank) {
        upserts.push({
          ...existing,
          uut_serial: '', cable_serial: '', backplane: '', notes: '', failure_notes: '', result: '',
          sync_status: 'pending', updated_at: now
        });
        hasChanges = true;
      }
    }
  }

  if (upserts.length) {
    await db.uut_entries.bulkPut(upserts);
  }
  if (hasChanges) {
    await db.sessions.update(sid, { sync_status: 'pending', updated_at: now });
  }
}

export async function dbAllSessions() {
  const all = await db.sessions.orderBy('id').reverse().toArray();
  return all.filter(s => Boolean(s.chamber || s.part_number || s.operator));
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

/**
 * "Delete" a UUT entry by blanking all its data fields.
 * The row stays in IndexedDB (needed for sync), but dbAllTests
 * filters out rows with no uut_serial so it disappears from the UI.
 */
export async function dbDeleteUutEntry(sid, channel) {
  const entries = await db.uut_entries.where('session_id').equals(sid).toArray();
  const target = entries
    .filter(e => e.channel === channel)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
  if (!target) return;
  const now = new Date().toISOString();
  await db.uut_entries.update(target.id, {
    uut_serial: '', cable_serial: '', backplane: '',
    notes: '', failure_notes: '', result: '',
    sync_status: 'pending', updated_at: now,
  });
  await db.sessions.update(sid, { sync_status: 'pending', updated_at: now });
}

/**
 * Update editable fields on a UUT entry (identified by session id + channel).
 * @param {number} sid     - local session ID
 * @param {number} channel - channel number
 * @param {object} fields  - { uut_serial, cable_serial, backplane, result, notes, failure_notes }
 */
export async function dbUpdateUutEntry(sid, channel, fields) {
  const entries = await db.uut_entries.where('session_id').equals(sid).toArray();
  const target = entries
    .filter(e => e.channel === channel)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];
  if (!target) return;
  const now = new Date().toISOString();
  await db.uut_entries.update(target.id, {
    ...fields,
    sync_status: 'pending',
    updated_at: now,
  });
  await db.sessions.update(sid, { sync_status: 'pending', updated_at: now });
}

/**
 * "Delete" a session and all its UUT entries by blanking all data fields.
 * Rows are kept in IndexedDB for sync purposes; the sync engine will
 * propagate the blanked state to all other browsers.
 */
export async function dbDeleteSession(sid) {
  const now = new Date().toISOString();

  // Blank all UUT entries for this session
  const entries = await db.uut_entries.where('session_id').equals(sid).toArray();
  for (const e of entries) {
    await db.uut_entries.update(e.id, {
      uut_serial: '', cable_serial: '', backplane: '',
      notes: '', failure_notes: '', result: '',
      sync_status: 'pending', updated_at: now,
    });
  }

  // Blank the session itself (keep the row for sync, but clear identifying data)
  await db.sessions.update(sid, {
    operator: '', chamber: '', station: '', part_number: '',
    test_type: '', start_time: null, end_time: null, closed_by: '',
    sync_status: 'pending', updated_at: now,
  });
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
  // Return all valid sessions that haven't been ended, regardless of device.
  // Must have identifying data (not deleted/blanked).
  return db.sessions.filter(s => {
    const hasData = Boolean(s.chamber || s.part_number || s.operator);
    return hasData && (s.end_time === null || s.end_time === '');
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

/**
 * Retrieve test counts and history for a given UUT serial (case-insensitive exact match).
 * Only counts completed test runs (sessions with end_time or entries with a recorded result).
 * 
 * @param {string} serial
 * @returns {Promise<{ full: number, mini: number, other: number, total: number, runs: Array }>}
 */
export async function getUutTestCounts(serial) {
  if (!serial || !serial.trim()) {
    return { full: 0, mini: 0, other: 0, total: 0, runs: [] };
  }
  const target = serial.trim().toLowerCase();
  const entries = await db.uut_entries.toArray();
  const sessions = await db.sessions.toArray();
  const sMap = Object.fromEntries(sessions.map(s => [s.id, s]));

  // Deduplicate entries by session_id + channel (taking latest updated_at)
  const latestBySessionChannel = new Map();
  for (const e of entries) {
    if (!e.uut_serial || e.uut_serial.trim().toLowerCase() !== target) continue;
    const key = `${e.session_id}_${e.channel}`;
    const existing = latestBySessionChannel.get(key);
    if (!existing || (e.updated_at && existing.updated_at && e.updated_at > existing.updated_at)) {
      latestBySessionChannel.set(key, e);
    }
  }

  let full = 0;
  let mini = 0;
  let other = 0;
  const runs = [];

  for (const e of latestBySessionChannel.values()) {
    const s = sMap[e.session_id];
    if (!s || !s.part_number) continue; // skip deleted/blanked sessions
    // Completed test: has end_time or has result
    const isCompleted = Boolean(s.end_time || e.result);
    if (!isCompleted) continue;

    const tt = s.test_type || '';
    if (/full/i.test(tt)) {
      full++;
    } else if (/mini/i.test(tt)) {
      mini++;
    } else {
      other++;
    }

    runs.push({
      session_id: s.id,
      operator: s.operator,
      chamber: s.chamber,
      station: s.station,
      part_number: s.part_number,
      test_type: s.test_type,
      start_time: s.start_time,
      end_time: s.end_time,
      channel: e.channel,
      result: e.result || '',
    });
  }

  return {
    full,
    mini,
    other,
    total: full + mini + other,
    runs: runs.sort((a, b) => (b.start_time || '').localeCompare(a.start_time || '')),
  };
}

export const DATA_CUTOFF_MS = new Date('2026-04-11T08:53:15').getTime();

/**
 * Retrieve all unique UUTs that have failed a Full Test and are awaiting a Mini Test.
 * A UUT qualifies if:
 * 1. It has at least one completed Full Test with result = 'FAIL' (on or after 4-11-2026).
 * 2. It has NOT achieved a 'PASS' on any subsequent Mini Test.
 * 3. It has completed fewer Mini Tests than max_mini_tests (default 2).
 *
 * @returns {Promise<Array<{ uut_serial: string, part_number: string, failed_date: string, chamber: string, station: string, failure_notes: string, mini_count: number, max_mini: number, latest_sid: number }>>}
 */
export async function getAwaitingMiniTestUuts() {
  const cfg = await loadConfig();
  const maxMini = cfg.max_mini_tests ?? 2;

  const entries = await db.uut_entries.toArray();
  const sessions = await db.sessions.toArray();
  const sMap = Object.fromEntries(sessions.map(s => [s.id, s]));

  // Deduplicate entries per session_id + channel taking latest updated_at
  const latestBySessionChannel = new Map();
  for (const e of entries) {
    if (!e.uut_serial || !e.uut_serial.trim()) continue;
    const key = `${e.session_id}_${e.channel}`;
    const existing = latestBySessionChannel.get(key);
    if (!existing || (e.updated_at && existing.updated_at && e.updated_at > existing.updated_at)) {
      latestBySessionChannel.set(key, e);
    }
  }

  // Group by unique UUT serial (case-insensitive)
  const uutMap = new Map();
  for (const e of latestBySessionChannel.values()) {
    const s = sMap[e.session_id];
    if (!s || !s.part_number) continue; // skip deleted/blanked sessions

    // Exclude records before cutoff date (4-11-2026)
    const t = s.start_time || s.end_time;
    if (!t || new Date(t).getTime() < DATA_CUTOFF_MS) continue;

    const isCompleted = Boolean(s.end_time || e.result);
    if (!isCompleted) continue;

    const serialTrimmed = e.uut_serial.trim();
    // Exclude any serial numbers that do not begin with "BH" (case-insensitive)
    if (!serialTrimmed.toLowerCase().startsWith('bh')) continue;

    const lc = serialTrimmed.toLowerCase();
    if (!uutMap.has(lc)) {
      uutMap.set(lc, { serial: serialTrimmed, runs: [] });
    }
    uutMap.get(lc).runs.push({
      session_id: s.id,
      operator: s.operator || '',
      chamber: s.chamber || '',
      station: s.station || '',
      part_number: s.part_number || '',
      test_type: s.test_type || '',
      start_time: s.start_time || '',
      end_time: s.end_time || '',
      channel: e.channel,
      result: (e.result || '').toUpperCase(),
      failure_notes: e.failure_notes || '',
      notes: e.notes || '',
    });
  }

  const results = [];

  for (const { serial, runs } of uutMap.values()) {
    // Sort runs chronologically descending (latest first)
    runs.sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''));

    // Do not include if the last test was a Full test and it passed
    const latestRun = runs[0];
    if (latestRun && /full/i.test(latestRun.test_type) && latestRun.result === 'PASS') {
      continue;
    }

    // Also do not include if the most recent Full test passed
    const latestFull = runs.find(r => /full/i.test(r.test_type));
    if (latestFull && latestFull.result === 'PASS') {
      continue;
    }

    let hasFullFail = false;
    let hasMiniPass = false;
    let miniCount = 0;
    let latestFullFail = null;
    let latestPartNumber = '';

    for (const r of runs) {
      if (!latestPartNumber && r.part_number) latestPartNumber = r.part_number;

      const isFull = /full/i.test(r.test_type);
      const isMini = /mini/i.test(r.test_type);

      if (isFull) {
        if (r.result === 'FAIL') {
          hasFullFail = true;
          if (!latestFullFail) latestFullFail = r;
        }
      } else if (isMini) {
        miniCount++;
        if (r.result === 'PASS') {
          hasMiniPass = true;
        }
      }
    }

    // Qualification condition:
    // 1. Has at least one Full Test FAIL
    // 2. Has NOT passed any Mini Test
    // 3. Mini test count < maxMini
    if (hasFullFail && !hasMiniPass && miniCount < maxMini) {
      results.push({
        uut_serial: serial,
        part_number: latestFullFail?.part_number || latestPartNumber,
        failed_date: latestFullFail?.start_time || '',
        chamber: latestFullFail?.chamber || '',
        station: latestFullFail?.station || '',
        failure_notes: latestFullFail?.failure_notes || '',
        mini_count: miniCount,
        max_mini: maxMini,
        latest_sid: latestFullFail?.session_id || 0,
      });
    }
  }

  // Sort by latest failure date descending
  return results.sort((a, b) => (b.failed_date || '').localeCompare(a.failed_date || ''));
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

/* ── Database Maintenance / Purge ─────────────────────────────────────── */

/**
 * Scans the database for records that match the purge criteria:
 * - Session date before 2026-04-11 (DATA_CUTOFF_MS), OR
 * - UUT Serial Number that does not begin with "BH" (case-insensitive)
 *
 * @returns {Promise<{
 *   purgeEntries: Array<object>,
 *   purgeSessions: Array<object>,
 *   totalEntries: number,
 *   totalSessions: number,
 * }>}
 */
export async function dbPreviewPurge() {
  const sessions = await db.sessions.toArray();
  const sMap = Object.fromEntries(sessions.map(s => [s.id, s]));
  const entries = await db.uut_entries.toArray();

  const totalEntries = entries.filter(e => e.uut_serial).length;
  const totalSessions = sessions.filter(s => s.chamber || s.part_number).length;

  const purgeEntries = [];
  const sessionRemainingEntries = new Map(); // sid -> remaining valid UUT count

  for (const e of entries) {
    if (!e.uut_serial) continue;
    const s = sMap[e.session_id];
    const sid = e.session_id;
    const sessionTime = s ? (s.start_time || s.end_time || s.created_at) : null;
    const isPreCutoff = sessionTime ? (new Date(sessionTime).getTime() < DATA_CUTOFF_MS) : false;
    const isNonBH = !e.uut_serial.trim().toLowerCase().startsWith('bh');

    if (isPreCutoff || isNonBH) {
      const reasons = [];
      if (isPreCutoff) reasons.push('Before 4/11/2026');
      if (isNonBH) reasons.push('Non-BH Serial');

      purgeEntries.push({
        id: e.id,
        sid: e.session_id,
        channel: e.channel,
        uut_serial: e.uut_serial,
        part_number: s ? s.part_number : '—',
        chamber: s ? s.chamber : '—',
        station: s ? s.station : '—',
        start_time: sessionTime || '',
        result: e.result || '—',
        failure_notes: e.failure_notes || '',
        notes: e.notes || '',
        reasons,
      });
    } else {
      sessionRemainingEntries.set(sid, (sessionRemainingEntries.get(sid) || 0) + 1);
    }
  }

  // Sessions to purge: either created before cutoff, or will have 0 valid UUT entries remaining
  const purgeSessions = [];
  for (const s of sessions) {
    if (!s.chamber && !s.part_number) continue; // already blanked
    const sessionTime = s.start_time || s.end_time || s.created_at;
    const isPreCutoff = sessionTime ? (new Date(sessionTime).getTime() < DATA_CUTOFF_MS) : false;
    const remainingCount = sessionRemainingEntries.get(s.id) || 0;

    if (isPreCutoff || remainingCount === 0) {
      const reasons = [];
      if (isPreCutoff) reasons.push('Before 4/11/2026');
      if (remainingCount === 0) reasons.push('No valid UUTs remaining');

      purgeSessions.push({
        id: s.id,
        chamber: s.chamber,
        station: s.station,
        part_number: s.part_number,
        operator: s.operator,
        start_time: s.start_time,
        end_time: s.end_time,
        reasons,
      });
    }
  }

  return {
    purgeEntries: purgeEntries.sort((a, b) => (b.start_time || '').localeCompare(a.start_time || '')),
    purgeSessions,
    totalEntries,
    totalSessions,
  };
}

/**
 * Execute the database purge for flagged entries and sessions.
 * Blanks all matching records and marks them with sync_status: 'pending' so
 * the changes are automatically propagated to Supabase.
 */
export async function dbExecutePurge() {
  const { purgeEntries, purgeSessions } = await dbPreviewPurge();
  const now = new Date().toISOString();

  // 1. Blank flagged UUT entries
  for (const e of purgeEntries) {
    await db.uut_entries.update(e.id, {
      uut_serial: '',
      cable_serial: '',
      backplane: '',
      notes: '',
      failure_notes: '',
      result: '',
      sync_status: 'pending',
      updated_at: now,
    });
  }

  // 2. Blank flagged sessions
  for (const s of purgeSessions) {
    await db.sessions.update(s.id, {
      operator: '',
      chamber: '',
      station: '',
      part_number: '',
      test_type: '',
      start_time: null,
      end_time: null,
      closed_by: '',
      sync_status: 'pending',
      updated_at: now,
    });
  }

  return {
    purgedEntriesCount: purgeEntries.length,
    purgedSessionsCount: purgeSessions.length,
  };
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
