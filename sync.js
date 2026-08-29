/**
 * Chamber Test Log – Supabase Sync Engine
 *
 * Local-first architecture:
 *  1. All reads/writes happen to IndexedDB first (works offline)
 *  2. Background sync pushes 'pending' records to Supabase
 *  3. Pull sync fetches records from other machines
 *  4. UUID-based identity prevents collisions across devices
 */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseConfig.js';
import db from './db.js';

/* ── Supabase Client ─────────────────────────────────────────────────── */
let supabase = null;
let syncEnabled = false;

export function isSyncEnabled() { return syncEnabled; }

export function initSync() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY ||
      SUPABASE_ANON_KEY === 'PASTE_YOUR_FULL_PUBLISHABLE_KEY_HERE') {
    console.warn('[Sync] Supabase not configured – running in local-only mode.');
    syncEnabled = false;
    return false;
  }
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    syncEnabled = true;
    console.log('[Sync] Supabase client initialized.');
    return true;
  } catch (err) {
    console.error('[Sync] Failed to initialize Supabase:', err);
    syncEnabled = false;
    return false;
  }
}

/* ── UUID Helper ─────────────────────────────────────────────────────── */
function newUUID() {
  return crypto.randomUUID();
}

/* ── Status Callback ─────────────────────────────────────────────────── */
let _onStatusChange = () => {};

export function onSyncStatus(cb) { _onStatusChange = cb; }

function setStatus(status, detail = '') {
  _onStatusChange(status, detail);
}

/* ── Push: Local → Supabase ──────────────────────────────────────────── */

async function pushSessions() {
  const pending = await db.sessions
    .where('sync_status').equals('pending')
    .toArray();

  if (!pending.length) return 0;

  // Ensure UUIDs for all pending sessions
  for (const s of pending) {
    if (!s.uuid) {
      s.uuid = newUUID();
      await db.sessions.update(s.id, { uuid: s.uuid });
    }
  }

  // Batch query remote records for active sessions to merge start_time/end_time/closed_by
  const activePendingUuids = pending
    .filter(s => Boolean(s.chamber || s.part_number || s.operator) && s.uuid)
    .map(s => s.uuid);

  const remoteSessionMap = {};
  if (activePendingUuids.length) {
    const { data: remoteSessions } = await supabase
      .from('sessions')
      .select('uuid, start_time, end_time, closed_by')
      .in('uuid', activePendingUuids);

    if (remoteSessions) {
      for (const r of remoteSessions) {
        remoteSessionMap[r.uuid] = r;
      }
    }
  }

  const pushTs = new Date().toISOString();
  const rows = [];
  const localUpdates = [];

  for (const s of pending) {
    const isBlanked = !s.chamber && !s.part_number && !s.operator;
    const remote = remoteSessionMap[s.uuid];

    const row = {
      uuid:        s.uuid,
      operator:    s.operator || '',
      chamber:     s.chamber || '',
      station:     s.station || '',
      part_number: s.part_number || '',
      test_type:   s.test_type || '',
      start_time:  isBlanked ? null : (s.start_time || (remote ? remote.start_time : null) || null),
      end_time:    isBlanked ? null : (s.end_time || (remote ? remote.end_time : null) || null),
      created_at:  s.created_at || '',
      closed_by:   isBlanked ? '' : (s.closed_by || (remote ? remote.closed_by : '') || ''),
      updated_at:  pushTs,
    };

    rows.push(row);
    localUpdates.push({
      ...s,
      start_time:  row.start_time,
      end_time:    row.end_time,
      closed_by:   row.closed_by,
      sync_status: 'synced',
      updated_at:  pushTs,
    });
  }

  if (rows.length) {
    const { error } = await supabase
      .from('sessions')
      .upsert(rows, { onConflict: 'uuid' });

    if (error) {
      console.error('[Sync] Push sessions error:', error.message);
      return 0;
    }

    await db.sessions.bulkPut(localUpdates);
  }

  return rows.length;
}

async function pushEntries() {
  const pending = await db.uut_entries
    .where('sync_status').equals('pending')
    .toArray();

  if (!pending.length) return 0;

  // Pre-load sessions to resolve session_uuid
  const sessionIds = [...new Set(pending.map(e => e.session_id))];
  const sessions = await db.sessions.where('id').anyOf(sessionIds).toArray();
  const sessionMap = Object.fromEntries(sessions.map(s => [s.id, s]));

  // Check result preservation in batch if any entries have empty result with valid serial
  const checkResultUuids = pending
    .filter(e => !e.result && e.uut_serial && e.uut_serial.trim() && e.uuid)
    .map(e => e.uuid);

  const remoteResultMap = {};
  if (checkResultUuids.length) {
    const { data: remoteResults } = await supabase
      .from('uut_entries')
      .select('uuid, result')
      .in('uuid', checkResultUuids);

    if (remoteResults) {
      for (const r of remoteResults) {
        if (r.result) remoteResultMap[r.uuid] = r.result;
      }
    }
  }

  const pushTs = new Date().toISOString();
  const rows = [];
  const localUpdates = [];

  for (const e of pending) {
    if (!e.uuid) {
      e.uuid = newUUID();
    }

    const session = sessionMap[e.session_id];
    if (!session || !session.uuid) {
      console.warn(`[Sync] Skipping entry ${e.id} – session ${e.session_id} has no UUID.`);
      continue;
    }

    const resolvedResult = e.result || remoteResultMap[e.uuid] || '';

    const row = {
      uuid:          e.uuid,
      session_uuid:  session.uuid,
      channel:       e.channel || 0,
      uut_serial:    e.uut_serial || '',
      cable_serial:  e.cable_serial || '',
      backplane:     e.backplane || '',
      notes:         e.notes || '',
      failure_notes: e.failure_notes || '',
      result:        resolvedResult,
      updated_at:    pushTs,
    };

    rows.push(row);
    localUpdates.push({
      ...e,
      result:      resolvedResult,
      sync_status: 'synced',
      updated_at:  pushTs,
    });
  }

  if (rows.length) {
    // Send in chunks of 200 to prevent payload limit issues
    const CHUNK_SIZE = 200;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      const { error } = await supabase
        .from('uut_entries')
        .upsert(chunk, { onConflict: 'uuid' });

      if (error) {
        console.error('[Sync] Push entries chunk error:', error.message);
      }
    }

    await db.uut_entries.bulkPut(localUpdates);
  }

  return rows.length;
}

async function pushConfig() {
  const cfgRow = await db.config.get('settings');
  if (!cfgRow || cfgRow.sync_status !== 'pending') return 0;

  const pushTs = new Date().toISOString();
  const { error } = await supabase
    .from('config')
    .upsert({
      key:        'settings',
      value:      cfgRow.value,
      updated_at: pushTs,
    }, { onConflict: 'key' });

  if (error) {
    console.error('[Sync] Push config error:', error.message);
    return 0;
  }

  // Update local with the SAME timestamp we pushed, so pullConfig won't overwrite
  await db.config.update('settings', { sync_status: 'synced', updated_at: pushTs });
  return 1;
}

/* ── Pull: Supabase → Local ──────────────────────────────────────────── */

/**
 * Fetch rows from a Supabase table using pagination.
 * If since (ISO timestamp) is provided, performs incremental delta sync.
 */
async function fetchSupabaseRows(table, orderBy = 'updated_at', since = null) {
  const PAGE_SIZE = 1000;
  let allRows = [];
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const to = from + PAGE_SIZE - 1;
    let query = supabase
      .from(table)
      .select('*')
      .order(orderBy, { ascending: false });

    if (since) {
      query = query.gt('updated_at', since);
    }

    const { data, error } = await query.range(from, to);

    if (error) {
      console.error(`[Sync] Error fetching ${table} (range ${from}-${to}):`, error.message);
      break;
    }

    if (data && data.length) {
      allRows.push(...data);
      if (data.length < PAGE_SIZE) {
        hasMore = false;
      } else {
        from += PAGE_SIZE;
      }
    } else {
      hasMore = false;
    }
  }

  return allRows;
}

async function pullSessions(since = null) {
  const data = await fetchSupabaseRows('sessions', 'updated_at', since);
  if (!data || !data.length) return 0;

  // Build a map of existing local sessions by UUID
  const localSessions = await db.sessions.toArray();
  const uuidMap = {};
  for (const s of localSessions) {
    if (s.uuid) uuidMap[s.uuid] = s;
  }

  const updates = [];
  const inserts = [];
  for (const remote of data) {
    const existing = uuidMap[remote.uuid];

    if (existing) {
      // Compare updated_at – if remote is newer, update local
      const remoteTs = new Date(remote.updated_at).getTime();
      const localTs = existing.updated_at
        ? new Date(existing.updated_at).getTime()
        : 0;

      if (remoteTs > localTs) {
        updates.push({
          ...existing,
          operator:    remote.operator,
          chamber:     remote.chamber,
          station:     remote.station,
          part_number: remote.part_number,
          test_type:   remote.test_type,
          start_time:  remote.start_time,
          end_time:    remote.end_time,
          created_at:  remote.created_at,
          closed_by:   remote.closed_by,
          sync_status: 'synced',
          updated_at:  remote.updated_at,
        });
      }
    } else {
      // New session from another device – insert locally
      inserts.push({
        uuid:        remote.uuid,
        operator:    remote.operator,
        chamber:     remote.chamber,
        station:     remote.station,
        part_number: remote.part_number,
        test_type:   remote.test_type,
        start_time:  remote.start_time,
        end_time:    remote.end_time,
        created_at:  remote.created_at,
        closed_by:   remote.closed_by,
        sync_status: 'synced',
        updated_at:  remote.updated_at,
      });
    }
  }

  if (updates.length) {
    await db.sessions.bulkPut(updates);
  }
  if (inserts.length) {
    await db.sessions.bulkAdd(inserts);
  }
  return updates.length + inserts.length;
}

async function pullEntries(since = null) {
  const data = await fetchSupabaseRows('uut_entries', 'updated_at', since);
  if (!data || !data.length) return 0;

  // Build maps
  const localEntries = await db.uut_entries.toArray();
  const entryUuidMap = {};
  for (const e of localEntries) {
    if (e.uuid) entryUuidMap[e.uuid] = e;
  }

  // Also need session UUID → local ID mapping
  const localSessions = await db.sessions.toArray();
  const sessUuidToLocalId = {};
  for (const s of localSessions) {
    if (s.uuid) sessUuidToLocalId[s.uuid] = s.id;
  }

  const updates = [];
  const inserts = [];
  for (const remote of data) {
    const localSessionId = sessUuidToLocalId[remote.session_uuid];
    if (localSessionId == null) continue; // session not known locally yet

    const existing = entryUuidMap[remote.uuid];

    if (existing) {
      const remoteTs = new Date(remote.updated_at).getTime();
      const localTs = existing.updated_at
        ? new Date(existing.updated_at).getTime()
        : 0;

      if (remoteTs > localTs) {
        // If remote is newer (remoteTs > localTs), remote state is authoritative.
        // When a record is deleted/purged remotely (empty uut_serial), wipe local fields.
        const isRemoteBlanked = !remote.uut_serial || !remote.uut_serial.trim();
        const resolvedResult = (isRemoteBlanked || remote.result)
          ? (remote.result || '')
          : (existing.result || '');

        updates.push({
          ...existing,
          session_id:    localSessionId,
          channel:       remote.channel,
          uut_serial:    remote.uut_serial || '',
          cable_serial:  remote.cable_serial || '',
          backplane:     remote.backplane || '',
          notes:         remote.notes !== undefined ? remote.notes : '',
          failure_notes: remote.failure_notes !== undefined ? remote.failure_notes : '',
          result:        resolvedResult,
          sync_status:   'synced',
          updated_at:    remote.updated_at,
        });
      }
    } else {
      inserts.push({
        uuid:          remote.uuid,
        session_id:    localSessionId,
        channel:       remote.channel,
        uut_serial:    remote.uut_serial    || '',
        cable_serial:  remote.cable_serial  || '',
        backplane:     remote.backplane     || '',
        notes:         remote.notes         || '',
        failure_notes: remote.failure_notes || '',
        result:        remote.result        || '',
        sync_status:   'synced',
        updated_at:    remote.updated_at,
      });
    }
  }

  if (updates.length) {
    await db.uut_entries.bulkPut(updates);
  }
  if (inserts.length) {
    await db.uut_entries.bulkAdd(inserts);
  }
  return updates.length + inserts.length;
}

async function pullConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .eq('key', 'settings')
    .maybeSingle();

  if (error || !data) return 0;

  const local = await db.config.get('settings');
  const remoteTs = new Date(data.updated_at).getTime();
  const localTs = local && local.updated_at
    ? new Date(local.updated_at).getTime()
    : 0;

  if (remoteTs > localTs) {
    await db.config.put({
      key:         'settings',
      value:       data.value,
      sync_status: 'synced',
      updated_at:  data.updated_at,
    });
    return 1;
  }
  return 0;
}

/* ── Full Sync ───────────────────────────────────────────────────────── */

let _syncing = false;
let _syncQueued = false;

export async function syncAll(forceFull = false) {
  if (!syncEnabled || !supabase) return;
  if (_syncing) {
    _syncQueued = true;
    return;
  }
  _syncing = true;
  _syncQueued = false;
  setStatus('syncing', 'Syncing…');

  try {
    // 1. Push local changes first in bulk
    const pushedSess    = await pushSessions();
    const pushedEntries = await pushEntries();
    const pushedConfig  = await pushConfig();

    // 2. Compute delta timestamp (with 2-minute safety buffer for clock differences)
    let pullSince = null;
    if (!forceFull) {
      const lastPull = localStorage.getItem('ctl_last_pulled_at');
      if (lastPull) {
        pullSince = new Date(new Date(lastPull).getTime() - 120000).toISOString();
      }
    }

    // 3. Pull remote changes (delta if pullSince is present)
    const pulledSess    = await pullSessions(pullSince);
    const pulledEntries = await pullEntries(pullSince);
    const pulledConfig  = await pullConfig();

    const totalPushed = pushedSess + pushedEntries + pushedConfig;
    const totalPulled = pulledSess + pulledEntries + pulledConfig;

    localStorage.setItem('ctl_last_pulled_at', new Date().toISOString());

    if (totalPushed || totalPulled) {
      console.log(`[Sync] Pushed ${totalPushed}, Pulled ${totalPulled}`);
    }

    setStatus('online', `Synced • ↑${totalPushed} ↓${totalPulled}`);
  } catch (err) {
    console.error('[Sync] syncAll error:', err);
    _syncQueued = false;
    setStatus('offline', 'Sync failed');
  } finally {
    _syncing = false;
    if (_syncQueued) {
      _syncQueued = false;
      setTimeout(() => syncAll(), 250);
    }
  }
}

/* ── Auto-sync (periodic background sync) ────────────────────────────── */

let _autoSyncInterval = null;

export function startAutoSync(intervalMs = 30000) {
  if (_autoSyncInterval) clearInterval(_autoSyncInterval);
  _autoSyncInterval = setInterval(() => {
    if (syncEnabled) syncAll();
  }, intervalMs);
  // Do an immediate sync
  if (syncEnabled) syncAll();
}

export function stopAutoSync() {
  if (_autoSyncInterval) {
    clearInterval(_autoSyncInterval);
    _autoSyncInterval = null;
  }
}

/* ── Online/Offline detection ────────────────────────────────────────── */

export function watchConnectivity() {
  window.addEventListener('online', () => {
    console.log('[Sync] Back online – syncing…');
    setStatus('syncing', 'Back online…');
    syncAll();
  });
  window.addEventListener('offline', () => {
    console.log('[Sync] Offline.');
    setStatus('offline', 'Offline – data saved locally');
  });

  // Set initial status
  if (!navigator.onLine) {
    setStatus('offline', 'Offline – data saved locally');
  }
}
