/**
 * Chamber Test Log – Web App  v1.0
 * Manufacturing Thermal Test Data Logger
 *
 * All data stored locally in IndexedDB via Dexie.js.
 */

import db, {
  loadConfig, saveConfig,
  dbNewSession, dbSetStart, dbSetEnd, dbSaveEntries,
  dbAllSessions, dbSessionEntries, dbDistinct,
  dbAllTests, dbGetOpenSessions, dbSearchUut,
  dbExportAll, dbImportAll,
  fmtTs,
} from './db.js';
import { initSync, syncAll, startAutoSync, onSyncStatus, watchConnectivity, isSyncEnabled } from './sync.js';
import JsBarcode from 'jsbarcode';

const MAX_CHANNELS = 12;

/* ═══════════════════════════════════════════════════════════════════════════
   Global State
   ═══════════════════════════════════════════════════════════════════════════ */
let config = {};
const activeSessions = [];   // { sid, win (DOM), state, rows, timers }
const minimizedSessions = []; // references from activeSessions

/* ═══════════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════════ */
function $(sel, ctx = document) { return ctx.querySelector(sel); }
function $$(sel, ctx = document) { return ctx.querySelectorAll(sel); }

/* ── Code 128 Barcode Generator ───────────────────────────────────────── */
/* ── Code 128 Barcode Generator (via JsBarcode) ──────────────────────── */
function generateCode128SVG(text) {
  if (!text) return '';
  try {
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svgEl, text, {
      format:       'CODE128',
      width:        0.8,    // bar module width in pixels
      height:       18,     // bar height in pixels
      displayValue: false,  // serial number shown as text above already
      margin:       4,      // quiet zone
      background:   '#ffffff',
      lineColor:    '#000000',
      xmlDocument:  document,
    });
    return svgEl.outerHTML;
  } catch (e) {
    console.warn('Barcode generation failed for:', text, e);
    return '';
  }
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function showView(id) {
  // Auto-minimize any non-minimized active sessions when leaving session view
  if (id !== 'view-session') {
    for (const sess of activeSessions) {
      if (!sess.minimized && !sess.ended) {
        sess.minimized = true;
        sess.el.style.display = 'none';
        // Silent save (no toast, no await — fire and forget)
        saveSession(sess, true).catch(() => {});
      }
    }
    refreshMinBar();
  }
  $$('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function pad(n) { return String(n).padStart(2, '0'); }

function elapsedStr(start, end) {
  if (!start) return '--:--:--';
  const s = new Date(start);
  const e = end ? new Date(end) : new Date();
  let secs = Math.max(0, Math.floor((e - s) / 1000));
  const h = Math.floor(secs / 3600); secs %= 3600;
  const m = Math.floor(secs / 60);   secs %= 60;
  return `${pad(h)}:${pad(m)}:${pad(secs)}`;
}

function downloadCSV(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Dashboard / Stats
   ═══════════════════════════════════════════════════════════════════════════ */
async function refreshStats() {
  const totalSessions = (await dbAllSessions()).length;

  const welcomeTitle = $('#welcome-title');
  const welcomeHint  = $('#welcome-hint');
  const welcomeIcon  = document.querySelector('.welcome-icon');

  if (activeSessions.length > 0) {
    welcomeIcon.style.display = 'none';
    welcomeTitle.style.display = 'none';
    welcomeHint.style.display = 'none';
  } else {
    welcomeIcon.style.display = '';
    welcomeTitle.style.display = '';
    welcomeHint.style.display = '';
  }

  const cards = $('#stats-cards');
  cards.innerHTML = '';
  const data = [
    { val: totalSessions, lbl: 'Total Sessions', color: 'var(--accent)' },
    { val: activeSessions.length, lbl: 'Active Sessions', color: 'var(--green)' },
  ];
  for (const d of data) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `<div class="stat-val" style="color:${d.color}">${d.val}</div><div class="stat-lbl">${d.lbl}</div>`;
    cards.appendChild(card);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Minimized Bar
   ═══════════════════════════════════════════════════════════════════════════ */
function refreshMinBar() {
  const bar = $('#minimized-bar');
  const area = $('#minimized-btn-area');
  area.innerHTML = '';
  const mins = activeSessions.filter(s => s.minimized);
  if (mins.length === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  for (const sess of mins) {
    const icon = sess.started && !sess.ended ? '▶' : (sess.ended ? '■' : '○');
    const elapsed = sess.started ? elapsedStr(sess.startTime, sess.ended ? sess.endTime : null) : '--:--:--';
    const btn = document.createElement('button');
    btn.className = 'min-btn';
    btn.innerHTML = `${icon}  ${sess.chamber} • ${sess.pn}  <span class="min-timer">${elapsed}</span>`;
    btn.onclick = () => restoreSession(sess);
    area.appendChild(btn);
  }
}

// update min bar labels every second
setInterval(() => {
  const area = $('#minimized-btn-area');
  if (!area) return;
  const mins = activeSessions.filter(s => s.minimized);
  const btns = area.querySelectorAll('.min-btn');
  mins.forEach((sess, i) => {
    if (!btns[i]) return;
    const icon = sess.started && !sess.ended ? '▶' : (sess.ended ? '■' : '○');
    const elapsed = sess.started ? elapsedStr(sess.startTime, sess.ended ? sess.endTime : null) : '--:--:--';
    btns[i].innerHTML = `${icon}  ${sess.chamber} • ${sess.pn}  <span class="min-timer">${elapsed}</span>`;
  });
}, 1000);

/* ═══════════════════════════════════════════════════════════════════════════
   New Session Modal
   ═══════════════════════════════════════════════════════════════════════════ */
/**
 * Check if a given part number is allowed in a given chamber.
 * Returns null if compatible, or a descriptive string if not.
 */
function checkChamberPartCompatibility(chamber, partNumber) {
  const matrix = config.chamber_part_matrix || {};
  const allowed = matrix[chamber];
  if (!allowed || allowed.length === 0) return null; // no rules → any part OK
  if (allowed.includes(partNumber)) return null;      // explicitly allowed
  return `Part "${partNumber}" is not approved for ${chamber}. Approved parts: ${allowed.join(', ')}`;
}

async function openNewSessionModal() {
  const overlay = $('#modal-overlay');
  const modal   = $('#modal-new-session');
  $$('.modal').forEach(m => m.style.display = 'none');
  modal.style.display = '';
  overlay.classList.remove('hidden');

  // Populate operators datalist
  const ops = await dbDistinct('operator');
  const dl = $('#dl-operators');
  dl.innerHTML = ops.map(o => `<option value="${o}">`).join('');

  // Populate stations
  const stSel = $('#ns-station');
  stSel.innerHTML = '<option value="">— Select —</option>' +
    (config.test_stations || []).map(s => `<option>${s}</option>`).join('');

  // Build combined Chamber & Part dropdown from matrix
  const dbParts = await dbDistinct('part_number');
  const allParts = [...new Set([...(config.part_numbers || []), ...dbParts])].sort((a, b) => a.localeCompare(b));
  const chambers = [...(config.chambers || [])].sort((a, b) => a.localeCompare(b));
  const matrix   = config.chamber_part_matrix || {};

  const cpSel = $('#ns-chamber-part');
  let html = '<option value="">— Select Chamber & Part —</option>';

  for (const chamber of chambers) {
    const allowed = matrix[chamber];
    // If chamber has matrix rules: only show those parts. Otherwise show all known parts.
    const parts = (allowed && allowed.length > 0)
      ? [...allowed].sort((a, b) => a.localeCompare(b))
      : allParts;
    if (!parts.length) continue;
    html += `<optgroup label="${chamber}">`;
    for (const part of parts) {
      html += `<option value="${chamber}||${part}">${part} * ${chamber}</option>`;
    }
    html += '</optgroup>';
  }

  // Fallback: if no chambers defined, list unrestricted part+chamber combos
  if (!chambers.length && allParts.length) {
    for (const part of allParts) {
      html += `<option value="||${part}">${part}</option>`;
    }
  }

  cpSel.innerHTML = html;

  // Clear fields
  $('#ns-operator').value = '';
  $('#ns-chamber-part').value = '';
  $('#ns-test-type').value = 'Full Test';

  // Remove any stale compat warning from a previous open
  const existingWarn = $('#ns-compat-warning');
  if (existingWarn) existingWarn.remove();
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $$('.modal').forEach(m => m.style.display = 'none');
}

async function confirmNewSession() {
  const op    = $('#ns-operator').value.trim();
  const cpVal = $('#ns-chamber-part').value;
  const st    = $('#ns-station').value.trim();
  const tt    = $('#ns-test-type').value.trim();

  if (!op || !cpVal || !st || !tt) {
    toast('All fields are required.', true);
    return;
  }

  const [ch, pn] = cpVal.split('||');
  if (!ch || !pn) {
    toast('Please select a valid Chamber & Part combination.', true);
    return;
  }

  // Chamber / station conflict check
  if (activeSessions.some(s => s.chamber === ch)) {
    toast(`Chamber ${ch} is already open in an active session.`, true);
    return;
  }
  if (activeSessions.some(s => s.station === st)) {
    toast(`Station ${st} is already in use in an active session.`, true);
    return;
  }

  const sid = await dbNewSession(op, ch, st, pn, tt);
  closeModal();
  createSessionView(sid, op, ch, st, pn, tt);
  await refreshStats();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Session View (12-channel data entry)
   ═══════════════════════════════════════════════════════════════════════════ */
function createSessionView(sid, operator, chamber, station, pn, tt, restoredStart = null) {
  const container = $('#view-session');

  const sess = {
    sid, operator, chamber, station, pn, tt,
    started: false, ended: false,
    startTime: null, endTime: null,
    minimized: false,
    tickInterval: null,
    el: null,
    rows: [],
  };

  // Build DOM
  const div = document.createElement('div');
  div.className = 'session-view';
  div.id = `session-${sid}`;
  div.innerHTML = `
    <div class="session-topbar">
      <div style="display:flex;align-items:center;gap:8px">
        <h2>🏭 Chamber ${chamber}</h2>
        <span class="session-meta">Station: ${station} | Part: ${pn} | Type: ${tt} | Operator: ${operator}</span>
      </div>
      <div>
        <button class="btn-ghost btn-back-dash">← Dashboard</button>
        <button class="btn-ghost btn-minimize-sess">⊟ Minimize</button>
      </div>
    </div>
    <div class="session-timebar">
      <span class="lbl-start" style="color:var(--muted)">Start: —</span>
      <span class="sep">|</span>
      <span class="lbl-end" style="color:var(--muted)">End: —</span>
      <span class="sep">|</span>
      <span class="status" style="color:var(--amber)">● NOT STARTED</span>
      <span class="sep">|</span>
      <span class="lbl-elapsed" style="color:var(--muted)">Elapsed: --:--:--</span>
      <div class="session-timebar-actions">
        <button class="btn-green btn-start-sess">▶ Start Session</button>
        <button class="btn-danger btn-end-sess" disabled>■ End Session</button>
        <button class="btn-ghost btn-save-sess">💾 Save</button>
        <button class="btn-ghost btn-export-sess">📤 Export CSV</button>
      </div>
    </div>
    <div class="session-grid">
      <table class="session-table">
        <thead>
          <tr>
            <th>Ch</th><th>UUT Serial Number</th><th>Cable Serial Number</th>
            <th>Backplane #</th><th>Operator Notes</th><th>Failure Notes</th><th>Result</th>
          </tr>
        </thead>
        <tbody class="session-tbody"></tbody>
      </table>
    </div>
  `;

  // Build 12 rows
  const tbody = div.querySelector('.session-tbody');
  for (let i = 0; i < MAX_CHANNELS; i++) {
    const ch = i + 1;
    const rowClass = i % 2 === 0 ? 'row-even' : 'row-odd';
    const tr = document.createElement('tr');
    tr.className = rowClass;
    tr.innerHTML = `
      <td class="ch-cell">${ch}</td>
      <td><input type="text" data-field="uut_serial" placeholder="" /></td>
      <td><input type="text" data-field="cable_serial" placeholder="" /></td>
      <td><input type="text" data-field="backplane" placeholder="" /></td>
      <td><input type="text" data-field="notes" placeholder="" /></td>
      <td><input type="text" data-field="failure_notes" placeholder="" /></td>
      <td><button class="result-btn r-none" data-result="">—</button></td>
    `;
    tbody.appendChild(tr);

    // Result toggle
    const resultBtn = tr.querySelector('.result-btn');
    resultBtn.addEventListener('click', () => {
      const cur = resultBtn.dataset.result;
      let next = '';
      if (cur === '') next = 'PASS';
      else if (cur === 'PASS') next = 'FAIL';
      else if (cur === 'FAIL') next = 'ABORTED';
      else next = '';
      resultBtn.dataset.result = next;
      resultBtn.className = 'result-btn ' + ({
        '': 'r-none', 'PASS': 'r-pass', 'FAIL': 'r-fail', 'ABORTED': 'r-aborted'
      }[next]);
      resultBtn.textContent = next || '—';
    });

    // Enter key → move to same column in next row
    const inputs = tr.querySelectorAll('input');
    inputs.forEach((input, colIdx) => {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const nextRowIdx = i + 1;
        if (nextRowIdx >= MAX_CHANNELS) return; // already on last row
        const nextTr = tbody.querySelectorAll('tr')[nextRowIdx];
        if (!nextTr) return;
        const nextInputs = nextTr.querySelectorAll('input');
        if (nextInputs[colIdx]) nextInputs[colIdx].focus();
      });
    });

    sess.rows.push({ ch, tr });
  }

  container.appendChild(div);
  sess.el = div;
  activeSessions.push(sess);

  // Bind actions
  div.querySelector('.btn-start-sess').addEventListener('click', () => startSession(sess));
  div.querySelector('.btn-end-sess').addEventListener('click', () => endSession(sess));
  div.querySelector('.btn-save-sess').addEventListener('click', () => saveSession(sess));
  div.querySelector('.btn-export-sess').addEventListener('click', () => exportSession(sess));
  div.querySelector('.btn-minimize-sess').addEventListener('click', () => minimizeSession(sess));
  div.querySelector('.btn-back-dash').addEventListener('click', () => {
    minimizeSession(sess);
  });

  // If restoring, apply start state
  if (restoredStart) {
    sess.startTime = restoredStart;
    sess.started = true;
    const ts = fmtTs(restoredStart);
    div.querySelector('.lbl-start').textContent = `Start: ${ts}`;
    div.querySelector('.lbl-start').style.color = 'var(--green)';
    div.querySelector('.status').textContent = '● RUNNING  (restored)';
    div.querySelector('.status').style.color = 'var(--amber)';
    div.querySelector('.btn-start-sess').disabled = true;
    div.querySelector('.btn-end-sess').disabled = false;
    startTick(sess);
  }

  // Show this session view
  showView('view-session');
  refreshStats();
}

function getSessionRowData(sess) {
  return sess.rows.map(r => {
    const inputs = r.tr.querySelectorAll('input');
    const resultBtn = r.tr.querySelector('.result-btn');
    return {
      channel:       r.ch,
      uut_serial:    inputs[0].value.trim(),
      cable_serial:  inputs[1].value.trim(),
      backplane:     inputs[2].value.trim(),
      notes:         inputs[3].value.trim(),
      failure_notes: inputs[4].value.trim(),
      result:        resultBtn.dataset.result || '',
    };
  });
}

async function saveSession(sess, silent = false) {
  await dbSaveEntries(sess.sid, getSessionRowData(sess));
  if (!silent) toast('Session saved.');
}

async function startSession(sess) {
  if (sess.started) return;

  const data = getSessionRowData(sess);

  // Require at least one UUT serial before starting
  const rowsWithUUT = data.filter(r => r.uut_serial);
  if (rowsWithUUT.length === 0) {
    toast('At least one UUT Serial Number is required before starting the session.', true);
    return;
  }

  // Every row with a UUT must have a cable serial, and vice versa
  const missingCable = [];
  const missingUUT = [];
  for (const r of data) {
    if (r.uut_serial && !r.cable_serial) missingCable.push(`Ch ${r.channel}`);
    if (r.cable_serial && !r.uut_serial) missingUUT.push(`Ch ${r.channel}`);
  }
  const errors = [];
  if (missingCable.length) errors.push(`Cable Serial required on: ${missingCable.join(', ')}`);
  if (missingUUT.length) errors.push(`UUT Serial required on: ${missingUUT.join(', ')}`);
  if (errors.length) {
    toast(errors.join('\n'), true);
    return;
  }

  // UUT serial conflict check (warning only, doesn't block)
  const mySerials = new Set(rowsWithUUT.map(r => r.uut_serial));
  for (const other of activeSessions) {
    if (other === sess || !other.started || other.ended) continue;
    const otherSerials = new Set(getSessionRowData(other).filter(r => r.uut_serial).map(r => r.uut_serial));
    const dupes = [...mySerials].filter(s => otherSerials.has(s));
    if (dupes.length) {
      toast(`⚠ UUT serial overlap with Chamber ${other.chamber}: ${dupes.join(', ')}`, true);
    }
  }

  sess.startTime = new Date().toISOString();
  sess.started = true;
  const ts = fmtTs(sess.startTime);
  sess.el.querySelector('.lbl-start').textContent = `Start: ${ts}`;
  sess.el.querySelector('.lbl-start').style.color = 'var(--green)';
  sess.el.querySelector('.status').textContent = '● RUNNING';
  sess.el.querySelector('.status').style.color = 'var(--green)';
  sess.el.querySelector('.btn-start-sess').disabled = true;
  sess.el.querySelector('.btn-end-sess').disabled = false;
  await dbSetStart(sess.sid, sess.startTime);
  await saveSession(sess);
  startTick(sess);
}

function startTick(sess) {
  if (sess.tickInterval) clearInterval(sess.tickInterval);
  sess.tickInterval = setInterval(() => {
    if (!sess.started || sess.ended) { clearInterval(sess.tickInterval); return; }
    const el = sess.el.querySelector('.lbl-elapsed');
    if (el) {
      el.textContent = `Elapsed: ${elapsedStr(sess.startTime)}`;
      el.style.color = 'var(--green)';
    }
  }, 1000);
}

async function endSession(sess) {
  if (sess.ended) return;

  // Validation: cable serial + result required for rows with UUT
  const data = getSessionRowData(sess);
  const missingCable = [];
  const missingResult = [];
  for (const r of data) {
    if (!r.uut_serial) continue;
    if (!r.cable_serial) missingCable.push(`Ch ${r.channel}`);
    if (!r.result) missingResult.push(`Ch ${r.channel}`);
  }
  if (missingCable.length || missingResult.length) {
    let msg = '';
    if (missingCable.length) msg += `Cable Serial required on: ${missingCable.join(', ')}\n`;
    if (missingResult.length) msg += `Pass/Fail/Aborted result required on: ${missingResult.join(', ')}`;
    toast(msg, true);
    return;
  }

  // Show End Session modal
  const overlay = $('#modal-overlay');
  const endMod  = $('#modal-end-session');
  const newMod  = $('#modal-new-session');
  const detMod  = $('#modal-uut-detail');
  newMod.style.display = 'none';
  detMod.style.display = 'none';
  endMod.style.display = '';
  overlay.classList.remove('hidden');

  // Populate meta
  const elapsed = elapsedStr(sess.startTime);
  $('#end-meta').textContent = `Chamber ${sess.chamber}  |  ${sess.pn}  |  Elapsed: ${elapsed}`;

  // Populate operators
  const ops = await dbDistinct('operator');
  const dl = $('#dl-operators-close');
  dl.innerHTML = ops.map(o => `<option value="${o}">`).join('');
  $('#end-operator').value = sess.operator;

  // Bind confirm
  const confirmBtn = $('#end-confirm');
  const cancelBtn  = $('#end-cancel');

  const newConfirm = confirmBtn.cloneNode(true);
  confirmBtn.replaceWith(newConfirm);
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.replaceWith(newCancel);

  newCancel.addEventListener('click', closeModal);
  newConfirm.addEventListener('click', async () => {
    const closingOp = $('#end-operator').value.trim();
    if (!closingOp) {
      toast('Please enter the closing operator name.', true);
      return;
    }
    sess.endTime = new Date().toISOString();
    sess.ended = true;
    if (sess.tickInterval) clearInterval(sess.tickInterval);
    await saveSession(sess);
    const ts = fmtTs(sess.endTime);
    sess.el.querySelector('.lbl-end').textContent = `End: ${ts}`;
    sess.el.querySelector('.lbl-end').style.color = 'var(--red)';
    sess.el.querySelector('.status').textContent = '● COMPLETED';
    sess.el.querySelector('.status').style.color = 'var(--muted)';
    sess.el.querySelector('.lbl-elapsed').textContent = `Elapsed: ${elapsedStr(sess.startTime, sess.endTime)}`;
    sess.el.querySelector('.lbl-elapsed').style.color = 'var(--muted)';
    sess.el.querySelector('.btn-end-sess').disabled = true;
    await dbSetEnd(sess.sid, sess.endTime, closingOp);

    // Build a plain session object to hand directly to the report preview
    const closedSession = {
      id:          sess.sid,
      operator:    sess.operator,
      chamber:     sess.chamber,
      station:     sess.station,
      part_number: sess.pn,
      test_type:   sess.tt,
      start_time:  sess.startTime,
      end_time:    sess.endTime,
      closed_by:   closingOp,
    };

    closeSession(sess);
    showView('view-dashboard');
    toast(`Chamber ${closedSession.chamber} session completed. Closed by: ${closingOp}`);

    // Show the print preview so the operator can print or close
    await showReportPreview(closedSession.id, closedSession);
  });
}

function exportSession(sess) {
  saveSession(sess);
  const data = getSessionRowData(sess);
  let csv = 'Chamber Test Log – Session Export\n\n';
  csv += 'Session ID,Operator,Chamber,Station,Part Number,Test Type,Start Time,End Time\n';
  csv += `${sess.sid},${sess.operator},${sess.chamber},${sess.station},${sess.pn},${sess.tt},${fmtTs(sess.startTime)},${fmtTs(sess.endTime)}\n\n`;
  csv += 'Channel,UUT Serial,Cable Serial,Backplane #,Operator Notes,Failure Notes,Result\n';
  for (const r of data) {
    if (!r.uut_serial && !r.cable_serial) continue;
    csv += `${r.channel},"${r.uut_serial}","${r.cable_serial}","${r.backplane}","${r.notes}","${r.failure_notes}",${r.result}\n`;
  }
  const now = new Date();
  const ts = `${pad(now.getMonth()+1)}${pad(now.getDate())}${now.getFullYear()}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  downloadCSV(`Chamber${sess.chamber}_${sess.pn}_${ts}.csv`, csv);
  toast('CSV exported.');
}

function minimizeSession(sess) {
  sess.minimized = true;
  sess.el.style.display = 'none';
  saveSession(sess, true).catch(() => {});
  showView('view-dashboard');
  refreshMinBar();
  refreshStats();
}

function restoreSession(sess) {
  sess.minimized = false;
  sess.el.style.display = '';
  showView('view-session');
  refreshMinBar();
  refreshStats();
}

function closeSession(sess) {
  if (sess.tickInterval) clearInterval(sess.tickInterval);
  if (sess.el) sess.el.remove();
  const idx = activeSessions.indexOf(sess);
  if (idx !== -1) activeSessions.splice(idx, 1);
  refreshMinBar();
  refreshStats();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Session History View
   ═══════════════════════════════════════════════════════════════════════════ */
let historyData = [];
async function loadHistory() {
  showView('view-history');
  // Sync first to ensure we have data from all devices
  if (isSyncEnabled()) await syncAll();
  historyData = await dbAllSessions();
  const tbody = $('#history-tbody');
  tbody.innerHTML = '';
  for (const s of historyData) {
    const tr = document.createElement('tr');
    tr.dataset.sid = s.id;
    tr.innerHTML = `
      <td>${s.id}</td><td>${s.operator}</td><td>${s.chamber}</td><td>${s.station}</td>
      <td>${s.part_number}</td><td>${s.test_type}</td>
      <td>${fmtTs(s.start_time)}</td><td>${fmtTs(s.end_time)}</td><td>${s.closed_by || '—'}</td>
      <td><button class="btn-ghost print-btn" title="Print Report" style="padding:4px 8px;font-size:1rem;margin:-4px;line-height:1;">🖨️</button></td>
    `;
    tr.addEventListener('click', (e) => {
      // Don't select row if clicking the print button
      if (e.target.closest('.print-btn')) return;
      $$('#history-tbody tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
    });
    
    // Add print handler
    const printBtn = tr.querySelector('.print-btn');
    if (printBtn) {
      printBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // prevent row click
        showReportPreview(s.id);
      });
    }

    tbody.appendChild(tr);
  }
}

async function showReportPreview(sid, sessionObj = null) {
  // Use provided session object, or look up in historyData, or fetch from DB
  let s = sessionObj || historyData.find(h => h.id === sid);
  if (!s) {
    const all = await dbAllSessions();
    s = all.find(h => h.id === sid);
  }
  if (!s) return;
  const entries = await dbSessionEntries(sid);

  $('#rep-generated').textContent = `Generated on ${fmtTs(new Date().toISOString())}`;
  $('#rep-sid').textContent = s.id;
  $('#rep-operator').textContent = s.operator;
  $('#rep-chamber').textContent = s.chamber;
  $('#rep-station').textContent = s.station;
  $('#rep-pn').textContent = s.part_number;
  $('#rep-type').textContent = s.test_type;
  $('#rep-start').textContent = fmtTs(s.start_time);
  $('#rep-end').textContent = fmtTs(s.end_time);
  $('#rep-duration').textContent = s.start_time ? elapsedStr(new Date(s.start_time).getTime(), s.end_time ? new Date(s.end_time).getTime() : null) : '--:--:--';
  $('#rep-closedby').textContent = s.closed_by || '—';

  const tbody = $('#rep-tbody');
  tbody.innerHTML = '';
  for (const e of entries) {
    const resultColor = e.result === 'PASS' ? 'var(--green)' : e.result === 'FAIL' ? 'var(--red)' : e.result === 'ABORTED' ? 'var(--amber)' : '';
    const barcodeSVG = e.uut_serial ? generateCode128SVG(e.uut_serial, 40, 2.0) : '';
    const uutCell = e.uut_serial
      ? `<div style="font-weight:600;">${e.uut_serial}</div><div class="barcode-cell" style="margin-top:2px;">${barcodeSVG}</div>`
      : '';
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #ddd';
    tr.innerHTML = `
      <td style="padding:6px;">${e.channel}</td>
      <td style="padding:6px;">${uutCell}</td>
      <td style="padding:6px;">${e.cable_serial || ''}</td>
      <td style="padding:6px;">${e.backplane || ''}</td>
      <td style="padding:6px;">${e.notes || ''}</td>
      <td style="padding:6px;">${e.failure_notes || ''}</td>
      <td style="padding:6px;color:${resultColor};font-weight:700;">${e.result || ''}</td>
    `;
    tbody.appendChild(tr);
  }

  // Hide other modals, show report preview
  $$('.modal').forEach(m => m.style.display = 'none');
  $('#modal-report-preview').style.display = '';
  $('#modal-overlay').classList.remove('hidden');
}

async function viewUUTDetail() {
  const sel = $('#history-tbody tr.selected');
  if (!sel) { toast('Please select a session first.', true); return; }
  const sid = parseInt(sel.dataset.sid);
  const entries = await dbSessionEntries(sid);

  const overlay = $('#modal-overlay');
  const detMod  = $('#modal-uut-detail');
  const newMod  = $('#modal-new-session');
  const endMod  = $('#modal-end-session');
  newMod.style.display = 'none';
  endMod.style.display = 'none';
  detMod.style.display = '';
  overlay.classList.remove('hidden');

  $('#detail-title').textContent = `Session ${sid} – UUT Details`;
  const tbody = $('#detail-tbody');
  tbody.innerHTML = '';
  for (const e of entries) {
    const resultClass = e.result === 'PASS' ? 'pass' : e.result === 'FAIL' ? 'fail' : e.result === 'ABORTED' ? 'abort' : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.channel}</td><td>${e.uut_serial || ''}</td><td>${e.cable_serial || ''}</td>
      <td>${e.backplane || ''}</td><td>${e.notes || ''}</td><td>${e.failure_notes || ''}</td>
      <td class="${resultClass}">${e.result || ''}</td>
    `;
    tbody.appendChild(tr);
  }
}

function exportSelectedSession() {
  const sel = $('#history-tbody tr.selected');
  if (!sel) { toast('Please select a session first.', true); return; }
  const sid = parseInt(sel.dataset.sid);
  const s = historyData.find(h => h.id === sid);
  if (!s) return;
  dbSessionEntries(sid).then(entries => {
    let csv = 'Session ID,Started By,Chamber,Station,Part Number,Test Type,Start Time,End Time,Closed By\n';
    csv += `${s.id},${s.operator},${s.chamber},${s.station},${s.part_number},${s.test_type},${fmtTs(s.start_time)},${fmtTs(s.end_time)},${s.closed_by||''}\n\n`;
    csv += 'Channel,UUT Serial,Cable Serial,Backplane #,Operator Notes,Failure Notes,Result\n';
    for (const e of entries) {
      csv += `${e.channel},"${e.uut_serial||''}","${e.cable_serial||''}","${e.backplane||''}","${e.notes||''}","${e.failure_notes||''}",${e.result||''}\n`;
    }
    downloadCSV(`Session_${sid}_export.csv`, csv);
    toast('CSV exported.');
  });
}

async function exportAllSessions() {
  const sessions = await dbAllSessions();
  let csv = '=== Chamber Test Log – Full Export ===\n';
  csv += `Exported: ${fmtTs(new Date().toISOString())}\n\n`;
  for (const s of sessions) {
    csv += `--- SESSION ${s.id} ---\n`;
    csv += 'Session ID,Started By,Chamber,Station,Part Number,Test Type,Start Time,End Time,Closed By\n';
    csv += `${s.id},${s.operator},${s.chamber},${s.station},${s.part_number},${s.test_type},${fmtTs(s.start_time)},${fmtTs(s.end_time)},${s.closed_by||''}\n\n`;
    csv += 'Channel,UUT Serial,Cable Serial,Backplane #,Operator Notes,Failure Notes,Result\n';
    const entries = await dbSessionEntries(s.id);
    for (const e of entries) {
      csv += `${e.channel},"${e.uut_serial||''}","${e.cable_serial||''}","${e.backplane||''}","${e.notes||''}","${e.failure_notes||''}",${e.result||''}\n`;
    }
    csv += '\n';
  }
  const now = new Date();
  const ts = `${pad(now.getMonth()+1)}${pad(now.getDate())}${now.getFullYear()}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  downloadCSV(`AllSessions_${ts}.csv`, csv);
  toast('All sessions exported.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   All Tests View
   ═══════════════════════════════════════════════════════════════════════════ */
const DEFAULT_CONFIG = {
  part_numbers:  [],
  chambers:      ['CH-01', 'CH-02', 'CH-03', 'CH-04'],
  test_stations: ['TS-01', 'TS-02', 'TS-03', 'TS-04'],
  // chamber_part_matrix: { 'CH-01': ['PN-A', 'PN-B'], ... }
  // A chamber with NO entry (or an empty array) accepts all parts.
  chamber_part_matrix: {},
};
const AT_COLS = [
  { key: 'start_time',    label: 'Start Time' },
  { key: 'sid',           label: 'Sess' },
  { key: 'operator',      label: 'Started By' },
  { key: 'closed_by',     label: 'Closed By' },
  { key: 'chamber',       label: 'Chamber' },
  { key: 'station',       label: 'Station' },
  { key: 'part_number',   label: 'Part Number' },
  { key: 'test_type',     label: 'Test Type' },
  { key: 'channel',       label: 'Ch' },
  { key: 'uut_serial',    label: 'UUT Serial' },
  { key: 'cable_serial',  label: 'Cable Serial' },
  { key: 'backplane',     label: 'Backplane #' },
  { key: 'notes',         label: 'Operator Notes' },
  { key: 'failure_notes', label: 'Failure Notes' },
  { key: 'result',        label: 'Result' },
  { key: 'end_time',      label: 'End Time' },
];

let allTestsData = [];
let atSortKey = 'start_time';
let atSortRev = false;

function buildATHead() {
  const headRow = $('#at-head-row');
  headRow.innerHTML = '';
  for (const col of AT_COLS) {
    const th = document.createElement('th');
    th.className = 'sortable';
    th.dataset.key = col.key;
    let arrow = '';
    if (atSortKey === col.key) arrow = atSortRev ? ' ▼' : ' ▲';
    th.textContent = col.label + arrow;
    th.addEventListener('click', () => {
      if (atSortKey === col.key) atSortRev = !atSortRev;
      else { atSortKey = col.key; atSortRev = false; }
      applyATFilters();
      buildATHead();
    });
    headRow.appendChild(th);
  }
}

async function loadAllTests() {
  showView('view-all-tests');
  // Sync first to ensure we have data from all devices
  if (isSyncEnabled()) await syncAll();
  allTestsData = await dbAllTests();

  // Populate filter dropdowns
  const distinct = (key) => {
    const vals = [...new Set(allTestsData.map(r => String(r[key] ?? '')).filter(Boolean))].sort();
    return vals;
  };
  const populateSelect = (sel, vals) => {
    sel.innerHTML = '<option>All</option>' + vals.map(v => `<option>${v}</option>`).join('');
  };
  populateSelect($('#at-chamber'), distinct('chamber'));
  populateSelect($('#at-station'), distinct('station'));
  populateSelect($('#at-part'),    distinct('part_number'));
  const chans = [...new Set(allTestsData.map(r => r.channel).filter(c => c != null))].sort((a, b) => a - b);
  populateSelect($('#at-channel'), chans.map(String));
  populateSelect($('#at-cable'),   distinct('cable_serial'));

  buildATHead();
  applyATFilters();
}

function getATActiveRows() {
  let rows = [...allTestsData];

  const filters = [
    { val: $('#at-result').value,  key: 'result' },
    { val: $('#at-chamber').value, key: 'chamber' },
    { val: $('#at-station').value, key: 'station' },
    { val: $('#at-type').value,    key: 'test_type' },
    { val: $('#at-part').value,    key: 'part_number' },
    { val: $('#at-channel').value, key: 'channel' },
    { val: $('#at-cable').value,   key: 'cable_serial' },
  ];

  for (const f of filters) {
    if (f.val === 'All') continue;
    const want = f.val === '—' ? '' : f.val;
    rows = rows.filter(r => String(r[f.key] ?? '') === String(want));
  }

  const search = $('#at-search').value.trim().toLowerCase();
  if (search) {
    rows = rows.filter(r => {
      const text = AT_COLS.map(c => {
        const v = r[c.key];
        if (c.key === 'start_time' || c.key === 'end_time') return fmtTs(v);
        return String(v ?? '');
      }).join(' ').toLowerCase();
      return text.includes(search);
    });
  }

  // Sort
  rows.sort((a, b) => {
    let va = a[atSortKey] ?? '';
    let vb = b[atSortKey] ?? '';
    if (atSortKey === 'sid' || atSortKey === 'channel') {
      va = Number(va) || 0;
      vb = Number(vb) || 0;
      return atSortRev ? vb - va : va - vb;
    }
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    return atSortRev ? vb.localeCompare(va) : va.localeCompare(vb);
  });

  return rows;
}

function applyATFilters() {
  const rows = getATActiveRows();
  const tbody = $('#all-tests-tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    const resultClass = r.result === 'PASS' ? 'row-pass' : r.result === 'FAIL' ? 'row-fail' : r.result === 'ABORTED' ? 'row-abort' : '';
    tr.className = resultClass;
    tr.innerHTML = AT_COLS.map(c => {
      let v = r[c.key] ?? '';
      if (c.key === 'start_time' || c.key === 'end_time') v = fmtTs(v);
      if (c.key === 'closed_by' && !v) v = '—';
      return `<td>${v}</td>`;
    }).join('');
    tbody.appendChild(tr);
  }
  const total = allTestsData.length;
  const shown = rows.length;
  const suffix = shown < total ? '  —  filters active' : '';
  $('#at-count').textContent = `${shown} of ${total} record(s)${suffix}`;
}

function exportAllTests() {
  const rows = getATActiveRows();
  if (!rows.length) { toast('No records match current filters.', true); return; }
  let csv = 'All Tests – Chronological Export\n';
  csv += `Exported: ${fmtTs(new Date().toISOString())}\n`;
  csv += `Showing ${rows.length} of ${allTestsData.length} records\n\n`;
  csv += AT_COLS.map(c => c.label).join(',') + '\n';
  for (const r of rows) {
    csv += AT_COLS.map(c => {
      let v = r[c.key] ?? '';
      if (c.key === 'start_time' || c.key === 'end_time') v = fmtTs(v);
      return `"${v}"`;
    }).join(',') + '\n';
  }
  const now = new Date();
  const ts = `${pad(now.getMonth()+1)}${pad(now.getDate())}${now.getFullYear()}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  downloadCSV(`AllTests_${ts}.csv`, csv);
  toast('CSV exported.');
}

function clearATFilters() {
  $('#at-search').value = '';
  $('#at-result').value = 'All';
  $('#at-chamber').value = 'All';
  $('#at-station').value = 'All';
  $('#at-type').value = 'All';
  $('#at-part').value = 'All';
  $('#at-channel').value = 'All';
  $('#at-cable').value = 'All';
  applyATFilters();
}

/* ═══════════════════════════════════════════════════════════════════════════
   UUT Search View
   ═══════════════════════════════════════════════════════════════════════════ */
let searchResults = [];
let searchQuery = '';

async function doSearch() {
  const q = $('#search-input').value.trim();
  if (!q) { toast('Please enter a UUT serial number to search.', true); return; }
  // Sync first to ensure we have data from all devices
  if (isSyncEnabled()) await syncAll();
  searchQuery = q;
  searchResults = await dbSearchUut(q);

  const lbl = $('#search-result-label');
  const tbody = $('#search-tbody');
  tbody.innerHTML = '';

  if (!searchResults.length) {
    lbl.textContent = `No results for "${q}"`;
    lbl.style.color = 'var(--red)';
    return;
  }

  lbl.textContent = `${searchResults.length} result(s) for "${q}"`;
  lbl.style.color = 'var(--green)';

  for (const r of searchResults) {
    const resultClass = r.result === 'PASS' ? 'pass' : r.result === 'FAIL' ? 'fail' : r.result === 'ABORTED' ? 'abort' : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.session_id}</td><td>${r.operator}</td><td>${r.chamber}</td><td>${r.station}</td>
      <td>${r.part_number}</td><td>${r.test_type}</td><td>${r.channel}</td>
      <td>${r.cable_serial}</td><td>${r.backplane}</td><td>${r.notes}</td>
      <td>${r.failure_notes}</td><td class="${resultClass}">${r.result || ''}</td>
      <td>${fmtTs(r.start_time)}</td><td>${fmtTs(r.end_time)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function clearSearch() {
  $('#search-input').value = '';
  $('#search-tbody').innerHTML = '';
  $('#search-result-label').textContent = '';
  searchResults = [];
}

function exportSearchResults() {
  if (!searchResults.length) { toast('Perform a search first.', true); return; }
  let csv = `UUT Serial Search Results – Query: ${searchQuery}\n`;
  csv += `Exported: ${fmtTs(new Date().toISOString())}\n\n`;
  csv += 'Session ID,Operator,Chamber,Station,Part Number,Test Type,Channel,Cable Serial,Backplane #,Notes,Failure Notes,Result,Start Time,End Time\n';
  for (const r of searchResults) {
    csv += `${r.session_id},"${r.operator}","${r.chamber}","${r.station}","${r.part_number}","${r.test_type}",${r.channel},"${r.cable_serial}","${r.backplane}","${r.notes}","${r.failure_notes}","${r.result}","${fmtTs(r.start_time)}","${fmtTs(r.end_time)}"\n`;
  }
  const now = new Date();
  const ts = `${pad(now.getMonth()+1)}${pad(now.getDate())}${now.getFullYear()}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  downloadCSV(`UUT_Search_${searchQuery}_${ts}.csv`, csv);
  toast('CSV exported.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Settings View
   ═══════════════════════════════════════════════════════════════════════════ */
function loadSettingsView() {
  showView('view-settings');
  renderSettingsLists();
  renderMatrix();
}

function renderSettingsLists() {
  $$('.setting-group').forEach(group => {
    const key = group.dataset.key;
    if (!key) return; // skip matrix-group which has no data-key
    const list = group.querySelector('.setting-list');
    if (!list) return;
    list.innerHTML = '';
    const items = config[key] || [];
    for (const item of items) {
      const chip = document.createElement('span');
      chip.className = 'setting-chip';
      chip.innerHTML = `${item} <button class="chip-remove">✕</button>`;
      chip.querySelector('.chip-remove').addEventListener('click', () => {
        config[key] = config[key].filter(v => v !== item);
        renderSettingsLists();
      });
      list.appendChild(chip);
    }
  });
}

function initSettingsEvents() {
  $$('.setting-group').forEach(group => {
    const key = group.dataset.key;
    if (!key) return; // skip matrix-group which has no data-key
    const input = group.querySelector('.setting-add-input');
    const addBtn = group.querySelector('.btn-add');

    const doAdd = () => {
      const val = input.value.trim();
      if (!val) return;
      if (!config[key]) config[key] = [];
      if (!config[key].includes(val)) {
        config[key].push(val);
        renderSettingsLists();
        renderMatrix(); // refresh matrix dropdowns when lists change
      }
      input.value = '';
    };

    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  });

  // Matrix add-rule button
  $('#matrix-add-btn').addEventListener('click', () => {
    const chamber = $('#matrix-chamber-sel').value;
    const part    = $('#matrix-part-sel').value;
    if (!chamber || !part) { toast('Select a chamber and a part number.', true); return; }
    if (!config.chamber_part_matrix) config.chamber_part_matrix = {};
    if (!config.chamber_part_matrix[chamber]) config.chamber_part_matrix[chamber] = [];
    if (!config.chamber_part_matrix[chamber].includes(part)) {
      config.chamber_part_matrix[chamber].push(part);
      renderMatrix();
    } else {
      toast(`${part} is already listed for ${chamber}.`, true);
    }
  });

  $('#settings-save').addEventListener('click', async () => {
    await saveConfig(config);
    toast('Settings saved.');
    showView('view-dashboard');
    await refreshStats();
    // Push immediately so other devices get the update
    if (isSyncEnabled()) syncAll();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Chamber-Part Matrix Rendering
   ═══════════════════════════════════════════════════════════════════════════ */
function renderMatrix() {
  const matrix  = config.chamber_part_matrix || {};
  const chambers = config.chambers || [];
  const parts    = config.part_numbers || [];
  const wrap    = $('#matrix-table-wrap');

  // Populate the add-rule dropdowns
  const chSel = $('#matrix-chamber-sel');
  const pSel  = $('#matrix-part-sel');
  chSel.innerHTML = chambers.map(c => `<option value="${c}">${c}</option>`).join('') ||
    '<option value="">No chambers defined</option>';
  pSel.innerHTML  = parts.map(p => `<option value="${p}">${p}</option>`).join('') ||
    '<option value="">No parts defined</option>';

  // Collect all rules as flat rows for the table
  const rows = [];
  for (const [ch, allowed] of Object.entries(matrix)) {
    for (const pn of (allowed || [])) {
      rows.push({ ch, pn });
    }
  }

  if (!rows.length) {
    wrap.innerHTML = '<div class="matrix-empty">No rules defined — all chambers accept all parts.</div>';
    return;
  }

  // Sort by chamber then part
  rows.sort((a, b) => a.ch.localeCompare(b.ch) || a.pn.localeCompare(b.pn));

  const table = document.createElement('table');
  table.className = 'matrix-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Chamber</th>
        <th>Allowed Part Number</th>
        <th style="width:50px;">Remove</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  for (const { ch, pn } of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ch}</td>
      <td>${pn}</td>
      <td><button class="chip-remove" title="Remove rule">✕</button></td>
    `;
    tr.querySelector('.chip-remove').addEventListener('click', () => {
      config.chamber_part_matrix[ch] = config.chamber_part_matrix[ch].filter(p => p !== pn);
      if (!config.chamber_part_matrix[ch].length) delete config.chamber_part_matrix[ch];
      renderMatrix();
    });
    tbody.appendChild(tr);
  }
  wrap.innerHTML = '';
  wrap.appendChild(table);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Session Restore
   ═══════════════════════════════════════════════════════════════════════════ */
async function restoreOpenSessions() {
  const openSessions = await dbGetOpenSessions();
  if (!openSessions.length) return;

  let restored = 0;
  for (const s of openSessions) {
    // Don't re-restore sessions that are already active
    if (activeSessions.some(a => a.sid === s.id)) continue;

    createSessionView(s.id, s.operator, s.chamber, s.station, s.part_number, s.test_type, s.start_time || null);

    // Load saved UUT entries
    const sess = activeSessions.find(a => a.sid === s.id);
    if (sess) {
      const entries = await dbSessionEntries(s.id);
      const entryMap = {};
      for (const e of entries) entryMap[e.channel] = e;

      for (const row of sess.rows) {
        const e = entryMap[row.ch];
        if (!e) continue;
        const inputs = row.tr.querySelectorAll('input');
        inputs[0].value = e.uut_serial || '';
        inputs[1].value = e.cable_serial || '';
        inputs[2].value = e.backplane || '';
        inputs[3].value = e.notes || '';
        inputs[4].value = e.failure_notes || '';
        const btn = row.tr.querySelector('.result-btn');
        btn.dataset.result = e.result || '';
        const cls = { '': 'r-none', 'PASS': 'r-pass', 'FAIL': 'r-fail', 'ABORTED': 'r-aborted' }[e.result || ''];
        btn.className = 'result-btn ' + cls;
        btn.textContent = e.result || '—';
      }

      // Minimise restored sessions so user can open them from the bar
      minimizeSession(sess);
      restored++;
    }
  }

  if (restored) {
    showView('view-dashboard');
    await refreshStats();
    toast(`${restored} active session(s) restored.`);
  }
}

/**
 * Refresh already-active sessions from the DB after sync.
 * Picks up start_time, end_time, and UUT changes made on other devices.
 */
async function refreshActiveSessions() {
  for (const sess of [...activeSessions]) {
    const dbSess = await db.sessions.get(sess.sid);
    if (!dbSess) continue;

    // Session was started on another device
    if (!sess.started && dbSess.start_time) {
      sess.startTime = dbSess.start_time;
      sess.started = true;
      const ts = fmtTs(sess.startTime);
      sess.el.querySelector('.lbl-start').textContent = `Start: ${ts}`;
      sess.el.querySelector('.lbl-start').style.color = 'var(--green)';
      sess.el.querySelector('.status').textContent = '● RUNNING';
      sess.el.querySelector('.status').style.color = 'var(--green)';
      sess.el.querySelector('.btn-start-sess').disabled = true;
      sess.el.querySelector('.btn-end-sess').disabled = false;
      startTick(sess);
    }

    // Refresh UUT entries from DB (may have been updated on another device)
    const entries = await dbSessionEntries(sess.sid);
    const entryMap = {};
    for (const e of entries) entryMap[e.channel] = e;

    for (const row of sess.rows) {
      const e = entryMap[row.ch];
      if (!e) continue;
      const inputs = row.tr.querySelectorAll('input');
      // Only update if the field is empty (don't overwrite local edits in progress)
      if (!inputs[0].value && e.uut_serial) inputs[0].value = e.uut_serial;
      if (!inputs[1].value && e.cable_serial) inputs[1].value = e.cable_serial;
      if (!inputs[2].value && e.backplane) inputs[2].value = e.backplane;
      if (!inputs[3].value && e.notes) inputs[3].value = e.notes;
      if (!inputs[4].value && e.failure_notes) inputs[4].value = e.failure_notes;
      const btn = row.tr.querySelector('.result-btn');
      if (!btn.dataset.result && e.result) {
        btn.dataset.result = e.result;
        const cls = { '': 'r-none', 'PASS': 'r-pass', 'FAIL': 'r-fail', 'ABORTED': 'r-aborted' }[e.result || ''];
        btn.className = 'result-btn ' + cls;
        btn.textContent = e.result || '—';
      }
    }
  }
  refreshMinBar();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Export / Import All Data
   ═══════════════════════════════════════════════════════════════════════════ */

async function exportAllData() {
  const data = await dbExportAll();
  const now = new Date();
  const ts = `${pad(now.getMonth()+1)}${pad(now.getDate())}${now.getFullYear()}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  downloadJSON(`ChamberTestLog_Export_${ts}.json`, data);
  toast(`Exported ${data.sessions.length} sessions and ${data.uut_entries.length} UUT entries.`);
}

let pendingImportData = null;

function openImportModal() {
  const overlay = $('#modal-overlay');
  // Hide all other modals
  $('#modal-new-session').style.display = 'none';
  $('#modal-end-session').style.display = 'none';
  $('#modal-uut-detail').style.display  = 'none';
  $('#modal-import').style.display = '';
  overlay.classList.remove('hidden');

  // Reset state
  pendingImportData = null;
  $('#import-file-name').textContent = 'No file selected';
  $('#import-file-input').value = '';
  $('#import-preview').style.display = 'none';
  $('#import-confirm').disabled = true;
  document.querySelector('input[name="import-mode"][value="replace"]').checked = true;
}

function handleImportFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  $('#import-file-name').textContent = file.name;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data._format !== 'ChamberTestLog_Export') {
        toast('Invalid file – not a Chamber Test Log export.', true);
        pendingImportData = null;
        $('#import-confirm').disabled = true;
        $('#import-preview').style.display = 'none';
        return;
      }
      pendingImportData = data;
      $('#import-confirm').disabled = false;

      // Show preview
      const sess = (data.sessions || []).length;
      const entries = (data.uut_entries || []).length;
      const exportDate = data._exportedAt ? fmtTs(data._exportedAt) : 'Unknown';
      $('#import-preview-text').innerHTML = `
        <strong>${sess}</strong> session(s), <strong>${entries}</strong> UUT entries<br>
        Exported: ${exportDate}
      `;
      $('#import-preview').style.display = '';
    } catch (err) {
      toast('Could not parse file – invalid JSON.', true);
      pendingImportData = null;
      $('#import-confirm').disabled = true;
      $('#import-preview').style.display = 'none';
    }
  };
  reader.readAsText(file);
}

async function confirmImport() {
  if (!pendingImportData) return;

  const mode = document.querySelector('input[name="import-mode"]:checked').value;

  if (mode === 'replace') {
    if (!confirm('This will DELETE all existing data and replace it with the import. Continue?')) return;
  }

  try {
    const result = await dbImportAll(pendingImportData, mode);
    closeModal();
    // Reload config in case it changed
    config = await loadConfig();
    await refreshStats();
    toast(`Import complete: ${result.sessions} sessions, ${result.entries} UUT entries (${mode}).`);
  } catch (err) {
    toast(`Import failed: ${err.message}`, true);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Wire Up Events
   ═══════════════════════════════════════════════════════════════════════════ */
function bindEvents() {
  // Nav
  const goHome = () => { showView('view-dashboard'); refreshStats(); };
  $('#btn-dashboard').addEventListener('click', goHome);
  $('#btn-home').addEventListener('click', goHome);
  $('#btn-new-session').addEventListener('click', openNewSessionModal);
  $('#btn-history').addEventListener('click', loadHistory);
  $('#btn-all-tests').addEventListener('click', loadAllTests);
  $('#btn-settings').addEventListener('click', loadSettingsView);

  // New Session modal
  $('#ns-cancel').addEventListener('click', closeModal);
  $('#ns-confirm').addEventListener('click', confirmNewSession);

  // History
  $('#history-refresh').addEventListener('click', loadHistory);
  $('#history-detail').addEventListener('click', viewUUTDetail);
  $('#history-export-sel').addEventListener('click', exportSelectedSession);
  $('#history-export-all').addEventListener('click', exportAllSessions);

  // Detail modal close
  $('#detail-close').addEventListener('click', closeModal);

  // Report modal
  $('#report-cancel').addEventListener('click', closeModal);
  $('#report-print').addEventListener('click', () => window.print());

  // All Tests
  $('#all-tests-refresh').addEventListener('click', loadAllTests);
  $('#all-tests-export').addEventListener('click', exportAllTests);
  $('#at-clear-filters').addEventListener('click', clearATFilters);

  // Live filter listeners for All Tests
  ['at-search', 'at-result', 'at-chamber', 'at-station', 'at-type', 'at-part', 'at-channel', 'at-cable'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', applyATFilters);
    el.addEventListener('change', applyATFilters);
  });

  // UUT Search
  $('#search-go').addEventListener('click', doSearch);
  $('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('#search-clear').addEventListener('click', clearSearch);
  $('#search-export').addEventListener('click', exportSearchResults);

  // Settings
  initSettingsEvents();

  // Export / Import
  $('#btn-export-data').addEventListener('click', exportAllData);
  $('#btn-import-data').addEventListener('click', openImportModal);
  $('#import-choose-file').addEventListener('click', () => $('#import-file-input').click());
  $('#import-file-input').addEventListener('change', handleImportFileSelected);
  $('#import-cancel').addEventListener('click', closeModal);
  $('#import-confirm').addEventListener('click', confirmImport);
  // Sync
  const syncBtn = $('#btn-sync');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      await syncAll();
      await refreshStats();
    });
  }

  // Close modal on overlay click (outside modal)
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════════════════════════ */
async function init() {
  config = await loadConfig();
  bindEvents();
  await refreshStats();
  showView('view-dashboard');

  // Restore any sessions that were open last time
  await restoreOpenSessions();

  // Initialize cloud sync
  const syncOk = initSync();
  onSyncStatus(async (status, detail) => {
    const el = $('#sync-status');
    if (!el) return;
    const colors = { online: 'var(--green)', syncing: 'var(--amber)', offline: 'var(--muted)' };
    const icons  = { online: '☁️', syncing: '🔄', offline: '⚡' };
    el.style.color = colors[status] || 'var(--muted)';
    el.innerHTML = `${icons[status] || '☁️'} ${detail}`;
    // After sync completes, refresh everything
    if (status === 'online') {
      // Reload config from DB — but NOT if user is actively editing Settings
      const settingsOpen = document.getElementById('view-settings')?.classList.contains('active');
      if (!settingsOpen) {
        config = await loadConfig();
      }

      // Remove sessions that were ended on another device
      const openIds = new Set((await dbGetOpenSessions()).map(s => s.id));
      for (let i = activeSessions.length - 1; i >= 0; i--) {
        if (!openIds.has(activeSessions[i].sid)) {
          closeSession(activeSessions[i]);
        }
      }
      // Restore any new open sessions from other devices
      await restoreOpenSessions();
      // Update state of existing sessions (started/data changed on other device)
      await refreshActiveSessions();
      await refreshStats();
    }
  });
  if (syncOk) {
    watchConnectivity();
    startAutoSync(30000); // sync every 30 seconds
  } else {
    const el = $('#sync-status');
    if (el) {
      el.style.color = 'var(--muted)';
      el.innerHTML = '⚡ Local only';
    }
  }
}

init();
