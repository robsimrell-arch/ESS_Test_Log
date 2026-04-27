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
  dbDeleteUutEntry, dbDeleteSession, dbUpdateUutEntry,
  fmtTs,
} from './db.js';
import { initSync, syncAll, startAutoSync, onSyncStatus, watchConnectivity, isSyncEnabled } from './sync.js';
import JsBarcode from 'jsbarcode';

const MAX_CHANNELS = 24;

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
        // Silent save (no toast, no await — fire and forget), skip prompt sync
        saveSession(sess, true, true).catch(() => {});
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
   Session View (24-channel data entry)
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

  // Build 24 rows
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

async function saveSession(sess, silent = false, skipSync = false) {
  // Pull latest from DB into DOM before reading DOM (avoids overwriting with stale tabs)
  await refreshActiveSessions();
  const data = getSessionRowData(sess);
  await dbSaveEntries(sess.sid, data);
  if (!silent) toast('Session saved.');
  
  // Trigger sync on manual save
  if (!skipSync && typeof isSyncEnabled === 'function' && isSyncEnabled()) {
    syncAll();
  }
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

  // Refresh UI from DB to avoid closing with stale blank data if synced recently
  await refreshActiveSessions();

  // Validation: cable serial + result required for rows with UUT
  const data = getSessionRowData(sess);

  // Require at least one UUT serial (cannot end a session with no data)
  const rowsWithUUT = data.filter(r => r.uut_serial);
  if (rowsWithUUT.length === 0) {
    toast('Cannot end session: no UUT data has been entered. Please add at least one UUT serial number.', true);
    return;
  }

  const missingCable = [];
  const missingResult = [];
  for (const r of data) {
    if (!r.uut_serial) continue;
    if (!r.cable_serial) missingCable.push(`Ch ${r.channel}`);
    if (!r.result) missingResult.push(`Ch ${r.channel}`);
  }

  if (missingCable.length || missingResult.length) {
    let msg = 'Missing required data:\n';
    if (missingCable.length) msg += `• Cable Serial required on: ${missingCable.join(', ')}\n`;
    if (missingResult.length) msg += `• Pass/Fail/Aborted result required on: ${missingResult.join(', ')}`;
    toast(msg, true);
    // Don't return here anymore—open the modal anyway but show the errors clearly and disable confirm.
    // Actually, user wants it "not possible to end", so blocking the modal is good, 
    // but the screenshot shows they managed to end it. Let's make the modal itself block.
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

  // Populate meta and validation summary
  const elapsed = elapsedStr(sess.startTime);
  const uutCount = rowsWithUUT.length;
  const passCount = data.filter(r => r.result === 'PASS').length;
  const failCount = data.filter(r => r.result === 'FAIL').length;
  const abortCount = data.filter(r => r.result === 'ABORTED').length;
  
  let validationHtml = `
    <div style="margin-bottom:12px; font-size:0.9rem; color:var(--text);">
      <div style="font-weight:700; margin-bottom:4px;">Chamber ${sess.chamber} • ${sess.pn}</div>
      <div style="color:var(--muted);">Elapsed: ${elapsed} | Station: ${sess.station}</div>
    </div>
    <div class="validation-summary" style="padding:12px; background:rgba(0,0,0,0.2); border-radius:6px; margin-bottom:16px; border:1px solid var(--border);">
      <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
        <span>UUTs Identified:</span>
        <span style="font-weight:700;">${uutCount}</span>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:10px; font-size:0.85rem;">
        <span style="color:var(--green)">✓ PASS: ${passCount}</span>
        <span style="color:var(--red)">✗ FAIL: ${failCount}</span>
        <span style="color:var(--amber)">⚠ ABORT: ${abortCount}</span>
      </div>
  `;

  if (missingCable.length || missingResult.length) {
    validationHtml += `
      <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border); color:var(--red); font-size:0.85rem;">
        <strong>Validation Errors:</strong><br>
        ${missingCable.length ? `• Missing Cable Serials: ${missingCable.length}<br>` : ''}
        ${missingResult.length ? `• Missing Results: ${missingResult.length}` : ''}
      </div>
    `;
  }
  validationHtml += `</div>`;
  
  $('#end-meta').innerHTML = validationHtml;

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

  // Disable confirm button if validation fails
  if (missingCable.length || missingResult.length || uutCount === 0) {
    newConfirm.disabled = true;
    newConfirm.title = "All UUTs must have Cable Serials and Results before ending.";
    newConfirm.style.opacity = '0.5';
    newConfirm.style.cursor = 'not-allowed';
  } else {
    newConfirm.disabled = false;
    newConfirm.title = "";
    newConfirm.style.opacity = '1';
    newConfirm.style.cursor = 'pointer';
  }

  newCancel.addEventListener('click', closeModal);
  newConfirm.addEventListener('click', async () => {
    const closingOp = $('#end-operator').value.trim();
    if (!closingOp) {
      toast('Please enter the closing operator name.', true);
      return;
    }

    // Re-validate from DOM right before committing — catches any sync race that
    // occurred between the "End Session" click (when the modal opened) and now.
    const confirmData = getSessionRowData(sess);
    const confirmMissingResult = confirmData.filter(r => r.uut_serial && !r.result).map(r => `Ch ${r.channel}`);
    const confirmMissingCable = confirmData.filter(r => r.uut_serial && !r.cable_serial).map(r => `Ch ${r.channel}`);
    const confirmRowsWithUUT = confirmData.filter(r => r.uut_serial);
    
    if (confirmRowsWithUUT.length === 0) {
      toast('Cannot end session: no UUT data found. Please re-enter data and try again.', true);
      closeModal();
      return;
    }
    if (confirmMissingResult.length || confirmMissingCable.length) {
      let m = 'Missing required data:\n';
      if (confirmMissingCable.length) m += `• Cable Serial required on: ${confirmMissingCable.join(', ')}\n`;
      if (confirmMissingResult.length) m += `• Pass/Fail/Aborted result required on: ${confirmMissingResult.join(', ')}`;
      toast(m, true);
      closeModal();
      return;
    }

    sess.endTime = new Date().toISOString();
    sess.ended = true;
    if (sess.tickInterval) clearInterval(sess.tickInterval);
    
    // Save the final data state to the DB
    await dbSaveEntries(sess.sid, confirmData);
    
    const ts = fmtTs(sess.endTime);
    sess.el.querySelector('.lbl-end').textContent = `End: ${ts}`;
    sess.el.querySelector('.lbl-end').style.color = 'var(--red)';
    sess.el.querySelector('.status').textContent = '● COMPLETED';
    sess.el.querySelector('.status').style.color = 'var(--muted)';
    sess.el.querySelector('.lbl-elapsed').textContent = `Elapsed: ${elapsedStr(sess.startTime, sess.endTime)}`;
    sess.el.querySelector('.lbl-elapsed').style.color = 'var(--muted)';
    sess.el.querySelector('.btn-end-sess').disabled = true;
    await dbSetEnd(sess.sid, sess.endTime, closingOp);

    // Immediate sync after session end
    if (typeof isSyncEnabled === 'function' && isSyncEnabled()) {
      console.log('[App] Triggering immediate sync after session end');
      syncAll();
    }

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
  saveSession(sess, true, true).catch(() => {});
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
      <td style="display:flex;gap:4px;align-items:center;">
        <button class="btn-ghost print-btn" title="Print Report" style="padding:4px 8px;font-size:1rem;margin:0;line-height:1;">🖨️</button>
        <button class="btn-ghost sess-del-btn" title="Delete Session" style="padding:4px 8px;font-size:1rem;margin:0;line-height:1;color:var(--red);border-color:transparent;">🗑️</button>
      </td>
    `;
    tr.addEventListener('click', (e) => {
      // Don't select row if clicking the print or delete button
      if (e.target.closest('.print-btn') || e.target.closest('.sess-del-btn')) return;
      $$('#history-tbody tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
    });

    // Print handler
    const printBtn = tr.querySelector('.print-btn');
    if (printBtn) {
      printBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showReportPreview(s.id);
      });
    }

    // Delete handler
    const delBtn = tr.querySelector('.sess-del-btn');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSessionDeleteModal(s, tr);
      });
    }

    tbody.appendChild(tr);
  }
}

/**
 * Open the password-protected session-delete modal.
 */
function openSessionDeleteModal(session, trEl) {
  $('#session-delete-info').innerHTML =
    `<strong style="color:var(--red);">Session ${session.id} will be permanently deleted:</strong><br>` +
    `<span style="color:var(--muted);">${session.operator} &nbsp;|&nbsp; ${session.chamber} &nbsp;|&nbsp; ${session.station}</span><br>` +
    `<span style="color:var(--muted);">Part: ${session.part_number} &nbsp;|&nbsp; ${session.test_type}</span><br>` +
    `<span style="color:var(--muted);">Started: ${fmtTs(session.start_time)}</span>`;

  const pw = $('#session-delete-pw');
  pw.value = '';
  $('#session-delete-error').style.display = 'none';

  // Clone buttons to clear stale listeners
  const confirmBtn = $('#session-delete-confirm');
  const cancelBtn  = $('#session-delete-cancel');
  const newConfirm = confirmBtn.cloneNode(true);
  const newCancel  = cancelBtn.cloneNode(true);
  confirmBtn.replaceWith(newConfirm);
  cancelBtn.replaceWith(newCancel);

  newCancel.addEventListener('click', closeModal);
  newConfirm.addEventListener('click', () => confirmSessionDelete(session, trEl));
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') confirmSessionDelete(session, trEl); });

  $$('.modal').forEach(m => m.style.display = 'none');
  $('#modal-session-delete').style.display = '';
  $('#modal-overlay').classList.remove('hidden');
  setTimeout(() => pw.focus(), 80);
}

async function confirmSessionDelete(session, trEl) {
  const pw = $('#session-delete-pw').value;
  if (pw !== 'TEngineer') {
    $('#session-delete-error').style.display = '';
    $('#session-delete-pw').value = '';
    $('#session-delete-pw').focus();
    return;
  }

  closeModal();

  await dbDeleteSession(session.id);

  // Remove from local cache and DOM
  historyData = historyData.filter(s => s.id !== session.id);
  if (trEl && trEl.parentNode) trEl.remove();

  // Sync to all browsers
  if (typeof isSyncEnabled === 'function' && isSyncEnabled()) syncAll();

  toast(`Session ${session.id} deleted and synced.`);
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
  { key: 'part_number',   label: 'Part Number' },
  { key: 'uut_serial',    label: 'UUT Serial' },
  { key: 'start_time',    label: 'Start Time' },
  { key: 'operator',      label: 'Started By' },
  { key: 'end_time',      label: 'End Time' },
  { key: 'closed_by',     label: 'Closed By' },
  { key: 'result',        label: 'Result' },
  { key: 'sid',           label: 'Sess' },
  { key: 'chamber',       label: 'Chamber' },
  { key: 'station',       label: 'Station' },
  { key: 'test_type',     label: 'Test Type' },
  { key: 'channel',       label: 'Ch' },
  { key: 'cable_serial',  label: 'Cable Serial' },
  { key: 'backplane',     label: 'Backplane #' },
  { key: 'notes',         label: 'Operator Notes' },
  { key: 'failure_notes', label: 'Failure Notes' },
];

let allTestsData = [];
let atSortKey = 'end_time';
let atSortRev = true;

// Records before this timestamp are excluded from all views by default.
// Users can still override by clearing the From date filter manually.
const DATA_CUTOFF_MS   = new Date('2026-04-11T08:53:15').getTime();
const DATA_CUTOFF_DATE = '2026-04-11'; // YYYY-MM-DD for date inputs

function buildATHead() {
  const thead = $('#all-tests-table').querySelector('thead');

  // Save current filter select values before wiping (sort clicks rebuild this)
  const FILTER_IDS = ['at-result','at-chamber','at-station','at-type','at-part','at-channel','at-cable','at-backplane'];
  const saved = {};
  for (const id of FILTER_IDS) { const el = $(`#${id}`); if (el) saved[id] = el.value; }

  thead.innerHTML = '';

  // ── Row 1: sortable column labels ────────────────────────────────────
  const headRow = document.createElement('tr');
  headRow.id = 'at-head-row';
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
  // Non-sortable Actions column (edit + delete)
  const delTh = document.createElement('th');
  delTh.style.cssText = 'width:70px;text-align:center;';
  headRow.appendChild(delTh);

  // ── Row 2: per-column filter controls ────────────────────────────────
  // Map each AT_COL key to the ID of its filter control (null = no filter)
  const FILTER_MAP = {
    part_number:   { type: 'select', id: 'at-part',     opts: null },
    uut_serial:    null, // handled by at-search in toolbar
    start_time:    null, // handled by date range in toolbar
    operator:      null,
    end_time:      null,
    closed_by:     null,
    result:        { type: 'select', id: 'at-result',   opts: ['PASS','FAIL','ABORTED','—'] },
    sid:           null,
    chamber:       { type: 'select', id: 'at-chamber',  opts: null },
    station:       { type: 'select', id: 'at-station',  opts: null },
    test_type:     { type: 'select', id: 'at-type',     opts: ['Full Test','Mini Test'] },
    channel:       { type: 'select', id: 'at-channel',  opts: null },
    cable_serial:  { type: 'select', id: 'at-cable',    opts: null },
    backplane:     { type: 'select', id: 'at-backplane',opts: null },
    notes:         null,
    failure_notes: null,
  };

  const filterRow = document.createElement('tr');
  filterRow.className = 'at-filter-row';

  for (const col of AT_COLS) {
    const td = document.createElement('th');
    td.className = 'at-filter-cell';
    const def = FILTER_MAP[col.key];
    if (def && def.type === 'select') {
      const sel = document.createElement('select');
      sel.id = def.id;
      sel.className = 'at-filter-sel';
      // Static options (for Result, Type) or placeholder (populated by loadAllTests)
      if (def.opts) {
        sel.innerHTML = '<option>All</option><option>[Exclude Blank]</option>' + def.opts.map(o => `<option>${o}</option>`).join('');
      } else {
        sel.innerHTML = '<option>All</option><option>[Exclude Blank]</option>';
      }
      if (saved[def.id]) {
        sel.value = saved[def.id];
      }
      sel.addEventListener('change', applyATFilters);
      td.appendChild(sel);
    }
    filterRow.appendChild(td);
  }
  // Empty cell for delete column
  filterRow.appendChild(document.createElement('th'));
  
  // Append filter row first, then column headers (so filters are ABOVE headings)
  thead.appendChild(filterRow);
  thead.appendChild(headRow);
}

async function loadAllTests() {
  showView('view-all-tests');
  // Sync first to ensure we have data from all devices
  if (isSyncEnabled()) await syncAll();
  allTestsData = await dbAllTests();

  // Build thead first so the inline filter <select> elements exist in the DOM
  buildATHead();

  // Populate filter dropdowns
  const distinct = (key) => {
    const vals = [...new Set(allTestsData.map(r => String(r[key] ?? '')).filter(Boolean))].sort();
    return vals;
  };
  const populateSelect = (sel, vals) => {
    sel.innerHTML = '<option>All</option><option>[Exclude Blank]</option>' + vals.map(v => `<option>${v}</option>`).join('');
  };
  populateSelect($('#at-chamber'), distinct('chamber'));
  populateSelect($('#at-station'), distinct('station'));
  populateSelect($('#at-part'),    distinct('part_number'));
  const chans = [...new Set(allTestsData.map(r => r.channel).filter(c => c != null))].sort((a, b) => a - b);
  populateSelect($('#at-channel'), chans.map(String));
  populateSelect($('#at-cable'),   distinct('cable_serial'));
  populateSelect($('#at-backplane'), distinct('backplane'));

  // Pre-set the From date to the data quality cutoff (only on fresh load)
  if (!$('#at-date-from').value) $('#at-date-from').value = DATA_CUTOFF_DATE;

  applyATFilters();
}


function getATActiveRows() {
  let rows = [...allTestsData];

  // Always exclude records before the data-quality cutoff date
  rows = rows.filter(r => {
    const t = r.end_time || r.start_time;
    return t && new Date(t).getTime() >= DATA_CUTOFF_MS;
  });

  const filters = [
    { val: $('#at-result').value,  key: 'result' },
    { val: $('#at-chamber').value, key: 'chamber' },
    { val: $('#at-station').value, key: 'station' },
    { val: $('#at-type').value,    key: 'test_type' },
    { val: $('#at-part').value,    key: 'part_number' },
    { val: $('#at-channel').value, key: 'channel' },
    { val: $('#at-cable').value,   key: 'cable_serial' },
    { val: $('#at-backplane').value, key: 'backplane' },
  ];

  for (const f of filters) {
    if (f.val === 'All') continue;
    if (f.val === '[Exclude Blank]') {
      rows = rows.filter(r => String(r[f.key] ?? '').trim() !== '');
      continue;
    }
    const want = f.val === '—' ? '' : f.val;
    rows = rows.filter(r => String(r[f.key] ?? '') === String(want));
  }

  // Date range filter — compare against end_time (falls back to start_time)
  const fromVal = $('#at-date-from').value; // 'YYYY-MM-DD' or ''
  const toVal   = $('#at-date-to').value;
  if (fromVal) {
    const fromMs = new Date(fromVal + 'T00:00:00').getTime();
    rows = rows.filter(r => {
      const t = r.end_time || r.start_time;
      return t && new Date(t).getTime() >= fromMs;
    });
  }
  if (toVal) {
    const toMs = new Date(toVal + 'T23:59:59').getTime();
    rows = rows.filter(r => {
      const t = r.end_time || r.start_time;
      return t && new Date(t).getTime() <= toMs;
    });
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
      if (c.key === 'failure_notes' || c.key === 'notes') {
        const full = String(v).replace(/"/g, '&quot;');
        return `<td class="td-truncate" title="${full}">${v}</td>`;
      }
      return `<td>${v}</td>`;
    }).join('');

    // Action buttons cell (edit + delete)
    const delTd = document.createElement('td');
    delTd.style.cssText = 'text-align:center;padding:2px 4px;white-space:nowrap;';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-ghost at-edit-btn';
    editBtn.title = 'Edit this record (password required)';
    editBtn.innerHTML = '✏️';
    editBtn.style.cssText = 'padding:2px 6px;font-size:.9rem;line-height:1;color:var(--accent);border-color:transparent;margin-right:2px;';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openATEditModal(r, tr);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-ghost at-delete-btn';
    delBtn.title = 'Delete this record (password required)';
    delBtn.innerHTML = '🗑️';
    delBtn.style.cssText = 'padding:2px 6px;font-size:.9rem;line-height:1;color:var(--red);border-color:transparent;';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openATDeleteModal(r, tr);
    });

    delTd.appendChild(editBtn);
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);

    tbody.appendChild(tr);
  }
  renderATCount(rows, allTestsData.length);

  // Refresh dropdowns to only show values present in the visible rows
  updateATFilterDropdowns(rows);
}

/**
 * Repopulate the dynamic filter dropdowns with only the distinct values
 * that appear in the currently visible (filtered) row set.
 * Preserves the current selection if it still exists in the new option list.
 * Setting innerHTML/value programmatically does NOT fire input/change events,
 * so there is no risk of triggering an infinite re-filter loop.
 */
function updateATFilterDropdowns(rows) {
  const distinct = (key) =>
    [...new Set(rows.map(r => String(r[key] ?? '')).filter(Boolean))].sort();

  const repopulate = (id, vals) => {
    const sel = $(`#${id}`);
    const current = sel.value;
    sel.innerHTML = '<option>All</option><option>[Exclude Blank]</option>' + vals.map(v => `<option>${v}</option>`).join('');
    // Restore selected value if it still exists in the new list
    if (current === '[Exclude Blank]') sel.value = current;
    else if (current !== 'All' && vals.includes(current)) sel.value = current;
  };

  repopulate('at-chamber', distinct('chamber'));
  repopulate('at-station', distinct('station'));
  repopulate('at-type',    distinct('test_type'));
  repopulate('at-part',    distinct('part_number'));

  const chans = [...new Set(rows.map(r => r.channel).filter(c => c != null))]
    .sort((a, b) => a - b).map(String);
  repopulate('at-channel', chans);

  repopulate('at-cable', distinct('cable_serial'));
  repopulate('at-backplane', distinct('backplane'));
}



/* ── Password-protected delete for All Tests rows ─────────────────────── */
let _atDeleteTarget = null; // { rowData, trEl }

function openATDeleteModal(rowData, trEl) {
  // Snapshot ALL filter state right now, before the modal can corrupt it
  const filterSnapshot = {
    search:  $('#at-search').value,
    result:  $('#at-result').value,
    chamber: $('#at-chamber').value,
    station: $('#at-station').value,
    type:    $('#at-type').value,
    part:    $('#at-part').value,
    channel: $('#at-channel').value,
    cable:   $('#at-cable').value,
    backplane: $('#at-backplane').value,
    dateFrom:$('#at-date-from').value,
    dateTo:   $('#at-date-to').value,
  };

  _atDeleteTarget = { rowData, trEl, filterSnapshot };
  const overlay = $('#modal-overlay');
  $$('.modal').forEach(m => m.style.display = 'none');
  $('#modal-at-delete').style.display = '';
  overlay.classList.remove('hidden');

  // Show what will be deleted
  const r = rowData;
  $('#at-delete-info').textContent =
    `UUT: ${r.uut_serial || '—'}  |  Session ${r.sid}  Ch ${r.channel}  |  ${r.result || 'No Result'}`;

  // Reset password input (clone to clear all previous keydown listeners)
  const oldPw = $('#at-delete-pw');
  const newPw = oldPw.cloneNode(true);
  newPw.value = '';
  oldPw.replaceWith(newPw);
  $('#at-delete-error').style.display = 'none';

  // Wire up buttons (clone to remove old listeners)
  const confirmBtn = $('#at-delete-confirm');
  const cancelBtn  = $('#at-delete-cancel');
  const newConfirm = confirmBtn.cloneNode(true);
  const newCancel  = cancelBtn.cloneNode(true);
  confirmBtn.replaceWith(newConfirm);
  cancelBtn.replaceWith(newCancel);

  newCancel.addEventListener('click', () => { _atDeleteTarget = null; closeModal(); });
  newConfirm.addEventListener('click', confirmATDelete);
  newPw.addEventListener('keydown', e => { if (e.key === 'Enter') confirmATDelete(); });

  setTimeout(() => newPw.focus(), 80);
}

async function confirmATDelete() {
  const pw = $('#at-delete-pw').value;
  if (pw !== 'TEngineer') {
    $('#at-delete-error').style.display = '';
    $('#at-delete-pw').value = '';
    $('#at-delete-pw').focus();
    return;
  }
  if (!_atDeleteTarget) return;
  const { rowData, trEl, filterSnapshot } = _atDeleteTarget;
  _atDeleteTarget = null;

  await dbDeleteUutEntry(rowData.sid, rowData.channel);

  // Remove from local in-memory cache
  allTestsData = allTestsData.filter(
    r => !(r.sid === rowData.sid && r.channel === rowData.channel)
  );

  // Restore filter state — browser autofill may have mutated inputs while modal was open
  $('#at-search').value     = filterSnapshot.search;
  $('#at-result').value     = filterSnapshot.result;
  $('#at-chamber').value    = filterSnapshot.chamber;
  $('#at-station').value    = filterSnapshot.station;
  $('#at-type').value       = filterSnapshot.type;
  $('#at-part').value       = filterSnapshot.part;
  $('#at-channel').value    = filterSnapshot.channel;
  $('#at-cable').value      = filterSnapshot.cable;
  $('#at-backplane').value  = filterSnapshot.backplane;
  $('#at-date-from').value  = filterSnapshot.dateFrom;
  $('#at-date-to').value    = filterSnapshot.dateTo;

  // Surgically remove just this row from the DOM — filter state is now guaranteed clean
  if (trEl && trEl.parentNode) trEl.remove();

  // Update the record count label
  renderATCount(allTestsData.filter(r => r !== rowData), allTestsData.length - 1);

  // Trigger sync if enabled
  if (typeof isSyncEnabled === 'function' && isSyncEnabled()) syncAll();

  closeModal();
  toast(`Record deleted: ${rowData.uut_serial} (Sess ${rowData.sid} Ch ${rowData.channel}).`);
}

/* ── Password-protected edit for All Tests rows ──────────────────────── */
let _atEditTarget = null; // { rowData, trEl, filterSnapshot }

function _snapshotATFilters() {
  return {
    search:   $('#at-search').value,
    result:   $('#at-result')?.value  ?? 'All',
    chamber:  $('#at-chamber')?.value ?? 'All',
    station:  $('#at-station')?.value ?? 'All',
    type:     $('#at-type')?.value    ?? 'All',
    part:     $('#at-part')?.value    ?? 'All',
    channel:  $('#at-channel')?.value ?? 'All',
    cable:    $('#at-cable')?.value   ?? 'All',
    backplane:$('#at-backplane')?.value ?? 'All',
    dateFrom: $('#at-date-from').value,
    dateTo:   $('#at-date-to').value,
  };
}

function _restoreATFilters(snap) {
  $('#at-search').value     = snap.search;
  if ($('#at-result'))   $('#at-result').value   = snap.result;
  if ($('#at-chamber'))  $('#at-chamber').value  = snap.chamber;
  if ($('#at-station'))  $('#at-station').value  = snap.station;
  if ($('#at-type'))     $('#at-type').value     = snap.type;
  if ($('#at-part'))     $('#at-part').value     = snap.part;
  if ($('#at-channel'))  $('#at-channel').value  = snap.channel;
  if ($('#at-cable'))    $('#at-cable').value    = snap.cable;
  if ($('#at-backplane'))$('#at-backplane').value= snap.backplane;
  $('#at-date-from').value  = snap.dateFrom;
  $('#at-date-to').value    = snap.dateTo;
}

function openATEditModal(rowData, trEl) {
  const filterSnapshot = _snapshotATFilters();
  _atEditTarget = { rowData, trEl, filterSnapshot };

  $$('.modal').forEach(m => m.style.display = 'none');
  $('#modal-at-edit').style.display = '';
  $('#modal-overlay').classList.remove('hidden');

  // Show record info
  const r = rowData;
  $('#at-edit-info').textContent =
    `UUT: ${r.uut_serial || '—'}  |  Session ${r.sid}  Ch ${r.channel}  |  ${r.result || 'No Result'}`;

  // Reset to Phase 1 (auth)
  $('#at-edit-auth-phase').style.display = '';
  $('#at-edit-form-phase').style.display = 'none';

  // Reset password
  const oldPw = $('#at-edit-pw');
  const newPw = oldPw.cloneNode(true);
  newPw.value = '';
  oldPw.replaceWith(newPw);
  $('#at-edit-error').style.display = 'none';

  // Show unlock button, hide save
  $('#at-edit-unlock').style.display = '';
  $('#at-edit-save').style.display = 'none';

  // Wire buttons (clone to clear old listeners)
  const cancelBtn  = $('#at-edit-cancel');
  const unlockBtn  = $('#at-edit-unlock');
  const saveBtn    = $('#at-edit-save');
  [cancelBtn, unlockBtn, saveBtn].forEach(b => {
    const nb = b.cloneNode(true);
    b.replaceWith(nb);
  });

  $('#at-edit-cancel').addEventListener('click', () => { _atEditTarget = null; closeModal(); });
  $('#at-edit-unlock').addEventListener('click', unlockATEdit);
  $('#at-edit-save').addEventListener('click', saveATEdit);

  newPw.addEventListener('keydown', e => { if (e.key === 'Enter') unlockATEdit(); });

  setTimeout(() => newPw.focus(), 80);
}

function unlockATEdit() {
  const pw = $('#at-edit-pw').value;
  if (pw !== 'TEngineer') {
    $('#at-edit-error').style.display = '';
    $('#at-edit-pw').value = '';
    $('#at-edit-pw').focus();
    return;
  }
  if (!_atEditTarget) return;
  const r = _atEditTarget.rowData;

  // Transition to Phase 2: populate fields
  $('#at-edit-auth-phase').style.display = 'none';
  $('#at-edit-form-phase').style.display = '';
  $('#at-edit-unlock').style.display = 'none';
  $('#at-edit-save').style.display = '';

  $('#at-edit-uut-serial').value    = r.uut_serial    || '';
  $('#at-edit-cable-serial').value  = r.cable_serial  || '';
  $('#at-edit-backplane').value     = r.backplane     || '';
  $('#at-edit-result').value        = r.result        || '';
  $('#at-edit-notes').value         = r.notes         || '';
  $('#at-edit-failure-notes').value = r.failure_notes || '';

  setTimeout(() => $('#at-edit-uut-serial').focus(), 80);
}

async function saveATEdit() {
  if (!_atEditTarget) return;
  const { rowData, trEl, filterSnapshot } = _atEditTarget;
  _atEditTarget = null;

  const fields = {
    uut_serial:    $('#at-edit-uut-serial').value.trim(),
    cable_serial:  $('#at-edit-cable-serial').value.trim(),
    backplane:     $('#at-edit-backplane').value.trim(),
    result:        $('#at-edit-result').value,
    notes:         $('#at-edit-notes').value.trim(),
    failure_notes: $('#at-edit-failure-notes').value.trim(),
  };

  await dbUpdateUutEntry(rowData.sid, rowData.channel, fields);

  // Update in-memory cache
  const cached = allTestsData.find(r => r.sid === rowData.sid && r.channel === rowData.channel);
  if (cached) Object.assign(cached, fields);

  // Restore filter state
  _restoreATFilters(filterSnapshot);

  // Re-render just the changed row's cells
  const updatedRow = cached || { ...rowData, ...fields };
  const resultClass = updatedRow.result === 'PASS' ? 'row-pass' : updatedRow.result === 'FAIL' ? 'row-fail' : updatedRow.result === 'ABORTED' ? 'row-abort' : '';
  trEl.className = resultClass;
  trEl.querySelectorAll('td:not(:last-child)').forEach((td, i) => {
    const col = AT_COLS[i];
    if (!col) return;
    let v = updatedRow[col.key] ?? '';
    if (col.key === 'start_time' || col.key === 'end_time') v = fmtTs(v);
    if (col.key === 'closed_by' && !v) v = '—';
    if (col.key === 'failure_notes' || col.key === 'notes') {
      const full = String(v).replace(/"/g, '&quot;');
      td.className = 'td-truncate';
      td.title = full;
    }
    td.textContent = v;
  });

  if (typeof isSyncEnabled === 'function' && isSyncEnabled()) syncAll();

  closeModal();
  toast(`Record updated: ${updatedRow.uut_serial || '(no serial)'} (Sess ${rowData.sid} Ch ${rowData.channel}).`);
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

/**
 * Render the pass/fail summary bar above the All Tests table.
 * @param {Array} rows  - the currently visible (filtered) rows
 * @param {number} total - total records in the full dataset
 */
function renderATCount(rows, total) {
  const shown   = rows.length;
  const passes  = rows.filter(r => r.result === 'PASS').length;
  const fails   = rows.filter(r => r.result === 'FAIL').length;
  const aborted = rows.filter(r => r.result === 'ABORTED').length;
  const other   = shown - passes - fails - aborted;

  // Percentages based on rows that have a definitive result
  const judged  = passes + fails;
  const passPct = judged > 0 ? ((passes / judged) * 100).toFixed(1) : null;
  const failPct = judged > 0 ? ((fails  / judged) * 100).toFixed(1) : null;

  const filtersActive = shown < total;

  $('#at-count').innerHTML = [
    `<span class="rc-total">${shown}${filtersActive ? ` of ${total}` : ''} record${shown !== 1 ? 's' : ''}${filtersActive ? ' &nbsp;<span class="rc-filter-tag">filtered</span>' : ''}</span>`,
    passes  > 0 ? `<span class="rc-pill rc-pass">✓ PASS&nbsp; ${passes}${passPct != null ? ` <span class="rc-pct">${passPct}%</span>` : ''}</span>` : '',
    fails   > 0 ? `<span class="rc-pill rc-fail">✗ FAIL&nbsp; ${fails}${failPct != null ? ` <span class="rc-pct">${failPct}%</span>` : ''}</span>` : '',
    aborted > 0 ? `<span class="rc-pill rc-abort">⊘ ABORTED&nbsp; ${aborted}</span>` : '',
    other   > 0 ? `<span class="rc-pill rc-blank">— Blank&nbsp; ${other}</span>` : '',
  ].join('');
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
  $('#at-backplane').value = 'All';
  $('#at-date-from').value = DATA_CUTOFF_DATE; // restore cutoff default
  $('#at-date-to').value = '';
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
    // Don't re-restore sessions that are already active (by ID, chamber, or station)
    if (activeSessions.some(a => a.sid === s.id)) continue;
    if (activeSessions.some(a => a.chamber === s.chamber)) {
      console.warn(`[Restore] Skipping session ${s.id} — chamber ${s.chamber} already has an active session.`);
      continue;
    }
    if (s.station && activeSessions.some(a => a.station === s.station)) {
      console.warn(`[Restore] Skipping session ${s.id} — station ${s.station} already has an active session.`);
      continue;
    }

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
   Equipment Health Statistics
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Compute per-equipment-item statistics from a flat array of test records.
 * Only PASS and FAIL results are counted; ABORTED records are excluded.
 *
 * @param {object[]} records  - Rows from dbAllTests() (already date-filtered)
 * @param {function} keyFn   - Function(record) => string key for grouping
 * @param {string}   label   - Human-readable label prefix for each item
 * @returns {object[]} Sorted array of stat objects (sorted by failRate desc)
 */
function computeEquipStats(records, keyFn) {
  const groups = new Map();

  for (const r of records) {
    if (r.result !== 'PASS' && r.result !== 'FAIL') continue; // skip ABORTED
    const key = keyFn(r);
    if (!key) continue; // skip empty values

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(r);
  }

  const stats = [];
  for (const [key, recs] of groups) {
    // Sort chronologically (oldest first) for streak calculation
    const sorted = [...recs].sort((a, b) => {
      const ta = a.end_time || a.start_time || '';
      const tb = b.end_time || b.start_time || '';
      return ta.localeCompare(tb);
    });

    const total    = sorted.length;
    const failures = sorted.filter(r => r.result === 'FAIL').length;
    const failRate = total > 0 ? (failures / total) * 100 : 0;

    // Most-recent records first for date lookups
    const descSorted = [...sorted].reverse();
    const lastPassRec = descSorted.find(r => r.result === 'PASS');
    const lastFailRec = descSorted.find(r => r.result === 'FAIL');
    const lastPass = lastPassRec ? (lastPassRec.end_time || lastPassRec.start_time) : null;
    const lastFail = lastFailRec ? (lastFailRec.end_time || lastFailRec.start_time) : null;

    // Consecutive failures: count from the most recent record backwards
    let consecutive = 0;
    for (const r of descSorted) {
      if (r.result === 'FAIL') consecutive++;
      else break;
    }

    // Risk tier (needs >= 3 tests for a meaningful tier)
    let tier;
    if (total < 3) {
      tier = 'unknown';
    } else if (failRate >= 70) {
      tier = 'critical';
    } else if (failRate >= 30) {
      tier = 'warning';
    } else {
      tier = 'healthy';
    }

    stats.push({ key, total, failures, failRate, lastPass, lastFail, consecutive, tier });
  }

  return stats;
}

/**
 * Determine the sort comparator function based on the chosen sort key.
 */
function equipSortFn(sortKey) {
  switch (sortKey) {
    case 'consecutive':
      return (a, b) => b.consecutive - a.consecutive || b.failRate - a.failRate;
    case 'totalTests':
      return (a, b) => b.total - a.total || b.failRate - a.failRate;
    case 'lastFail':
      return (a, b) => (b.lastFail || '').localeCompare(a.lastFail || '') || b.failRate - a.failRate;
    default: // failRate
      return (a, b) => b.failRate - a.failRate || b.consecutive - a.consecutive;
  }
}

/**
 * Build a single equipment health card DOM element.
 */
function buildEquipCard(stat, categoryLabel) {
  const { key, total, failures, failRate, lastPass, lastFail, consecutive, tier } = stat;

  const tierLabel = {
    critical: '🔴 Critical',
    warning:  '🟡 Warning',
    healthy:  '🟢 Healthy',
    unknown:  '❓ Low Data',
  }[tier];
  const badgeClass = `badge-${tier}`;
  const pctClass   = tier === 'unknown' ? '' : tier;
  const pctStr     = tier === 'unknown' ? 'N/A' : `${failRate.toFixed(1)}%`;

  // Consecutive badge styling
  const streakClass = consecutive >= 5 ? 'streak-high'
                    : consecutive >= 2 ? 'streak-mid'
                    : 'streak-low';
  const streakIcon  = consecutive >= 5 ? '🔴' : consecutive >= 2 ? '⚠️' : 'ℹ️';

  const card = document.createElement('div');
  card.className = `equip-card risk-${tier}`;
  card.innerHTML = `
    <div class="equip-card-header">
      <div>
        <div style="font-size:.7rem;color:var(--muted);margin-bottom:2px;">${categoryLabel}</div>
        <div class="equip-card-id">${key}</div>
      </div>
      <span class="equip-risk-badge ${badgeClass}">${tierLabel}</span>
    </div>

    <div class="equip-failbar-wrap">
      <div class="equip-failbar-label">
        <span>Fail Rate</span>
        <span class="fail-pct ${pctClass}">${pctStr}</span>
      </div>
      <div class="equip-failbar-track">
        <div class="equip-failbar-fill ${pctClass || 'unknown'}"
             style="width:${tier === 'unknown' ? 0 : Math.min(failRate, 100)}%"></div>
      </div>
    </div>

    <div class="equip-pills">
      <span class="equip-pill">∑ Tests: <span class="pill-val">${total}</span></span>
      <span class="equip-pill pill-fail">✗ Fails: <span class="pill-val">${failures}</span></span>
      <span class="equip-pill pill-pass">✓ Passes: <span class="pill-val">${total - failures}</span></span>
    </div>

    ${consecutive > 0 ? `
    <div class="equip-consecutive ${streakClass}">
      ${streakIcon} ${consecutive} Consecutive Failure${consecutive !== 1 ? 's' : ''} (most recent)
    </div>` : ''}

    <div class="equip-dates">
      <div>
        <div class="equip-date-lbl">🟢 Last Pass</div>
        <div class="equip-date-val ${lastPass ? '' : 'never'}">${lastPass ? fmtTs(lastPass) : 'Never'}</div>
      </div>
      <div>
        <div class="equip-date-lbl">🔴 Last Fail</div>
        <div class="equip-date-val ${lastFail ? '' : 'never'}">${lastFail ? fmtTs(lastFail) : 'Never'}</div>
      </div>
    </div>
  `;

  // Jump to UUT History on double-click
  card.addEventListener('dblclick', async () => {
    await loadAllTests(); // Switches view, loads data, and populates dropdowns

    // Reset all filters manually (preserve cutoff as the From default)
    $('#at-search').value = '';
    $('#at-result').value = 'All';
    $('#at-chamber').value = 'All';
    $('#at-station').value = 'All';
    $('#at-type').value = 'All';
    $('#at-part').value = 'All';
    $('#at-channel').value = 'All';
    $('#at-cable').value = 'All';
    $('#at-date-from').value = DATA_CUTOFF_DATE;
    $('#at-date-to').value = '';

    // Apply the specific filter for this equipment
    if (categoryLabel === 'Cable Serial') {
      $('#at-cable').value = key;
    } else if (categoryLabel === 'Backplane') {
      $('#at-search').value = key;
    } else if (categoryLabel === 'Station / Channel') {
      const match = key.match(/(.+) \/ Ch (\d+)/);
      if (match) {
        $('#at-station').value = match[1];
        $('#at-channel').value = match[2];
      }
    }

    applyATFilters();
  });

  return card;
}

/**
 * Render a list of stats into a target grid element.
 */
function renderEquipGrid(gridEl, stats, categoryLabel) {
  gridEl.innerHTML = '';
  if (!stats.length) {
    gridEl.innerHTML = '<div class="equip-empty">No data available for the selected filters.</div>';
    return;
  }
  for (const stat of stats) {
    gridEl.appendChild(buildEquipCard(stat, categoryLabel));
  }
}

let equipHealthData = [];

async function loadEquipHealth() {
  showView('view-equip-health');
  if (isSyncEnabled()) await syncAll();
  equipHealthData = await dbAllTests();

  // Populate part number filter from data
  const parts = [...new Set(equipHealthData.map(r => r.part_number).filter(Boolean))].sort();
  const ehPart = $('#eh-part');
  ehPart.innerHTML = '<option>All</option>' + parts.map(p => `<option>${p}</option>`).join('');

  // Pre-set the From date to the data quality cutoff (only on fresh load)
  if (!$('#eh-date-from').value) $('#eh-date-from').value = DATA_CUTOFF_DATE;

  applyEquipFilters();
}

function getEquipFilteredRecords() {
  let rows = [...equipHealthData];

  // Always exclude records before the data-quality cutoff date
  rows = rows.filter(r => {
    const t = r.end_time || r.start_time;
    return t && new Date(t).getTime() >= DATA_CUTOFF_MS;
  });

  // Date range filter
  const fromVal = $('#eh-date-from').value;
  const toVal   = $('#eh-date-to').value;
  if (fromVal) {
    const fromMs = new Date(fromVal + 'T00:00:00').getTime();
    rows = rows.filter(r => {
      const t = r.end_time || r.start_time;
      return t && new Date(t).getTime() >= fromMs;
    });
  }
  if (toVal) {
    const toMs = new Date(toVal + 'T23:59:59').getTime();
    rows = rows.filter(r => {
      const t = r.end_time || r.start_time;
      return t && new Date(t).getTime() <= toMs;
    });
  }

  // Part number filter
  const part = $('#eh-part').value;
  if (part && part !== 'All') {
    rows = rows.filter(r => r.part_number === part);
  }

  return rows;
}

function applyEquipFilters() {
  const rows    = getEquipFilteredRecords();
  const sortKey = $('#eh-sort').value;
  const sortFn  = equipSortFn(sortKey);

  // Compute stats for each category
  const cableStats  = computeEquipStats(rows, r => r.cable_serial || '').sort(sortFn);
  const bpStats     = computeEquipStats(rows, r => r.backplane    || '').sort(sortFn);
  const stChanStats = computeEquipStats(rows, r => r.station && r.channel != null ? `${r.station} / Ch ${r.channel}` : '').sort(sortFn);

  // Update tab counts
  $('#eh-count-cables').textContent     = cableStats.length;
  $('#eh-count-backplanes').textContent = bpStats.length;
  $('#eh-count-stations').textContent   = stChanStats.length;

  // Render grids
  renderEquipGrid($('#eh-grid-cables'),     cableStats,  'Cable Serial');
  renderEquipGrid($('#eh-grid-backplanes'), bpStats,     'Backplane');
  renderEquipGrid($('#eh-grid-stations'),   stChanStats, 'Station / Channel');

  // Update summary banner (aggregate across all equipment types together)
  const allStats = [...cableStats, ...bpStats, ...stChanStats];
  const nCritical = allStats.filter(s => s.tier === 'critical').length;
  const nWarning  = allStats.filter(s => s.tier === 'warning').length;
  const nHealthy  = allStats.filter(s => s.tier === 'healthy').length;
  const nUnknown  = allStats.filter(s => s.tier === 'unknown').length;
  const totalRecs = rows.filter(r => r.result === 'PASS' || r.result === 'FAIL').length;
  $('#equip-summary-bar').innerHTML = `
    <span style="color:var(--muted);">${totalRecs} test records analyzed</span>
    <span class="equip-summary-item"><span class="equip-summary-dot critical"></span>${nCritical} Critical (≥70% fail)</span>
    <span class="equip-summary-item"><span class="equip-summary-dot warning"></span>${nWarning} Warning (30–69%)</span>
    <span class="equip-summary-item"><span class="equip-summary-dot healthy"></span>${nHealthy} Healthy (&lt;30%)</span>
    ${nUnknown ? `<span style="color:var(--muted);">${nUnknown} insufficient data (&lt;3 tests)</span>` : ''}
  `;
}

function bindEquipHealthTabs() {
  $$('.equip-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.equip-tab').forEach(t => t.classList.remove('active'));
      $$('.equip-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      const sectionId = tab.dataset.section;
      const section = document.getElementById(sectionId);
      if (section) section.classList.add('active');
    });
  });
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
  $('#btn-equip-health').addEventListener('click', loadEquipHealth);
  $('#btn-settings').addEventListener('click', loadSettingsView);

  // Equipment Health filters
  bindEquipHealthTabs();
  $('#equip-health-refresh').addEventListener('click', loadEquipHealth);
  ['eh-date-from', 'eh-date-to', 'eh-part', 'eh-sort'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('change', applyEquipFilters);
  });
  $('#eh-clear-filters').addEventListener('click', () => {
    $('#eh-date-from').value = DATA_CUTOFF_DATE; // restore cutoff default
    $('#eh-date-to').value   = '';
    $('#eh-part').value      = 'All';
    $('#eh-sort').value      = 'failRate';
    applyEquipFilters();
  });

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


  // Live filter listeners for static toolbar controls only.
  // The inline thead selects (at-result, at-chamber, etc.) are dynamic –
  // their listeners are wired inside buildATHead() to avoid null errors on startup.
  ['at-search', 'at-date-from', 'at-date-to'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
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
