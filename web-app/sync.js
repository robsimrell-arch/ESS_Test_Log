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

  let pushed = 0;
  for (const s of pending) {
    // Ensure UUID
    if (!s.uuid) {
      s.uuid = newUUID();
      await db.sessions.update(s.id, { uuid: s.uuid });
    }

    // Fetch existing remote record to merge (don't overwrite non-null with null)
    let remoteStartTime = null;
    let remoteEndTime = null;
    let remoteClosedBy = '';
    const { data: existing } = await supabase
      .from('sessions')
      .select('start_time, end_time, closed_by')
      .eq('uuid', s.uuid)
      .single();
    if (existing) {
      remoteStartTime = existing.start_time;
      remoteEndTime = existing.end_time;
      remoteClosedBy = existing.closed_by;
    }
    const pushTs = new Date().toISOString();
    const row = {
      uuid:        s.uuid,
      operator:    s.operator || '',
      chamber:     s.chamber || '',
      station:     s.station || '',
      part_number: s.part_number || '',
      test_type:   s.test_type || '',
      start_time:  s.start_time || remoteStartTime || null,
      end_time:    s.end_time || remoteEndTime || null,
      created_at:  s.created_at || '',
      closed_by:   s.closed_by || remoteClosedBy || '',
      updated_at:  pushTs,
    };

    const { error } = await supabase
      .from('sessions')
      .upsert(row, { onConflict: 'uuid' });

    if (error) {
      console.error('[Sync] Push session error:', error.message);
      continue;
    }

    // Also update local DB with merged values + matching timestamp
    await db.sessions.update(s.id, {
      start_time:  row.start_time,
      end_time:    row.end_time,
      closed_by:   row.closed_by,
      sync_status: 'synced',
      updated_at:  pushTs,
    });
    pushed++;
  }
  return pushed;
}

async function pushEntries() {
  const pending = await db.uut_entries
    .where('sync_status').equals('pending')
    .toArray();

  if (!pending.length) return 0;

  let pushed = 0;
  for (const e of pending) {
    // Ensure UUID
    if (!e.uuid) {
      e.uuid = newUUID();
      await db.uut_entries.update(e.id, { uuid: e.uuid });
    }

    // We need the session UUID (not local ID) for the foreign key
    const session = await db.sessions.get(e.session_id);
    if (!session || !session.uuid) {
      console.warn(`[Sync] Skipping entry ${e.id} – session ${e.session_id} has no UUID.`);
      continue;
    }

    const pushTs = new Date().toISOString();
    const row = {
      uuid:          e.uuid,
      session_uuid:  session.uuid,
      channel:       e.channel || 0,
      uut_serial:    e.uut_serial || '',
      cable_serial:  e.cable_serial || '',
      backplane:     e.backplane || '',
      notes:         e.notes || '',
      failure_notes: e.failure_notes || '',
      result:        e.result || '',
      updated_at:    pushTs,
    };

    const { error } = await supabase
      .from('uut_entries')
      .upsert(row, { onConflict: 'uuid' });

    if (error) {
      console.error('[Sync] Push entry error:', error.message);
      continue;
    }

    await db.uut_entries.update(e.id, { sync_status: 'synced', updated_at: pushTs });
    pushed++;
  }
  return pushed;
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

async function pullSessions() {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[Sync] Pull sessions error:', error.message);
    return 0;
  }
  if (!data || !data.length) return 0;

  // Build a map of existing local sessions by UUID
  const localSessions = await db.sessions.toArray();
  const uuidMap = {};
  for (const s of localSessions) {
    if (s.uuid) uuidMap[s.uuid] = s;
  }

  let pulled = 0;
  for (const remote of data) {
    const existing = uuidMap[remote.uuid];

    if (existing) {
      // Compare updated_at – if remote is newer, update local
      const remoteTs = new Date(remote.updated_at).getTime();
      const localTs = existing.updated_at
        ? new Date(existing.updated_at).getTime()
        : 0;

      if (remoteTs > localTs) {
        await db.sessions.update(existing.id, {
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
        pulled++;
      }
    } else {
      // New session from another device – insert locally
      await db.sessions.add({
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
      pulled++;
    }
  }
  return pulled;
}

async function pullEntries() {
  const { data, error } = await supabase
    .from('uut_entries')
    .select('*')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[Sync] Pull entries error:', error.message);
    return 0;
  }
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

  let pulled = 0;
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
        await db.uut_entries.update(existing.id, {
          session_id:    localSessionId,
          channel:       remote.channel,
          uut_serial:    remote.uut_serial,
          cable_serial:  remote.cable_serial,
          backplane:     remote.backplane,
          notes:         remote.notes,
          failure_notes: remote.failure_notes,
          result:        remote.result,
          sync_status:   'synced',
          updated_at:    remote.updated_at,
        });
        pulled++;
      }
    } else {
      await db.uut_entries.add({
        uuid:          remote.uuid,
        session_id:    localSessionId,
        channel:       remote.channel,
        uut_serial:    remote.uut_serial,
        cable_serial:  remote.cable_serial,
        backplane:     remote.backplane,
        notes:         remote.notes,
        failure_notes: remote.failure_notes,
        result:        remote.result,
        sync_status:   'synced',
        updated_at:    remote.updated_at,
      });
      pulled++;
    }
  }
  return pulled;
}

async function pullConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .eq('key', 'settings')
    .single();

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

export async function syncAll() {
  if (!syncEnabled || !supabase || _syncing) return;
  _syncing = true;
  setStatus('syncing', 'Syncing…');

  try {
    // Push local changes first
    const pushedSess    = await pushSessions();
    const pushedEntries = await pushEntries();
    const pushedConfig  = await pushConfig();

    // Then pull remote changes
    const pulledSess    = await pullSessions();
    const pulledEntries = await pullEntries();
    const pulledConfig  = await pullConfig();

    const totalPushed = pushedSess + pushedEntries + pushedConfig;
    const totalPulled = pulledSess + pulledEntries + pulledConfig;

    if (totalPushed || totalPulled) {
      console.log(`[Sync] Pushed ${totalPushed}, Pulled ${totalPulled}`);
    }

    setStatus('online', `Synced • ↑${totalPushed} ↓${totalPulled}`);
  } catch (err) {
    console.error('[Sync] syncAll error:', err);
    setStatus('offline', 'Sync failed');
  } finally {
    _syncing = false;
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
