// ═══════════════════════════════════════════════════════════════════
//  MeterIQ Backend — Google Apps Script  v26
//
//  SETUP (one-time):
//  1. Open your Google Sheet → Extensions → Apps Script → paste this code
//  2. Save → Deploy → New deployment
//       Type: Web App | Execute as: Me | Access: Anyone
//  3. Copy the Web App URL → paste into MeterIQ BACKEND_URL constant
//
//  v26 changes: saveFeedback + getFeedback actions, Feedback sheet tab
// ═══════════════════════════════════════════════════════════════════

const CONFIG = {
  SHEET_ID:        '',               // Leave blank — auto-uses the bound sheet
  DRIVE_FOLDER_ID: '',               // Leave blank — auto-creates MeterIQ folders
  TOKEN_SECRET:    'meteriq2026_cw', // Change to something private
};

const SHEETS = {
  USERS:      'Users',
  PROPERTIES: 'Properties',
  UNITS:      'Units',
  READINGS:   'Readings',
  SYNC_LOG:   'SyncLog',
  FEEDBACK:   'Feedback',
};

// ── HELPER: safely parse a value that may arrive as a JSON string ───
function parseParam(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch(e) { return v; }
}

// ── AUTO-SETUP ──────────────────────────────────────────────────────
function onOpen() { autoSetupIfNeeded(); }

function autoSetupIfNeeded() {
  const ss        = getSpreadsheet();
  const userSheet = ss.getSheetByName(SHEETS.USERS);
  const unitSheet = ss.getSheetByName(SHEETS.UNITS);
  if (!userSheet || !unitSheet || unitSheet.getLastRow() <= 1) {
    setupSheets();
  }
}

// ── ENTRY POINTS ───────────────────────────────────────────────────
function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  try {
    autoSetupIfNeeded();

    const params = e.parameter || {};
    const body   = {};
    try { if (e.postData) Object.assign(body, JSON.parse(e.postData.contents || '{}')); } catch(x) {}
    const merged = Object.assign({}, body, params);

    const action = merged.action;
    const token  = merged.token;

    if (!action) return json({ ok: true, message: 'MeterIQ backend ready' });

    // ── Public actions (no token required) ──────────────────────────
    if (action === 'setup')          return json(setupSheets());
    if (action === 'ping')           return json({ ok: true, ts: new Date().toISOString() });
    if (action === 'authPin')        return json(authPin(merged));
    if (action === 'resetUsers')     return json(resetUsers());
    if (action === 'getLoginUsers')  return json(getLoginUsers());

    // ── Feedback: token optional — allow logged-out pilot users to submit ──
    if (action === 'saveFeedback') {
      const fb = parseParam(merged.feedback);
      return json(saveFeedback(fb));
    }

    // ── Authenticated actions ────────────────────────────────────────
    const user = verifyToken(token);
    if (!user) return json({ ok: false, error: 'Invalid or expired session' });

    switch (action) {
      case 'syncDown':     return json(syncDown(user, merged));
      case 'pushReading':  return json(pushReading(user, merged));
      case 'pushImage':    return json(pushImage(user, merged));
      case 'getUsers':     return json(getUsers(user));
      case 'saveUser':     return json(saveUser(user, merged));
      case 'deleteUser':   return json(deleteUser(user, merged));
      case 'saveProperty': return json(saveProperty(user, merged));
      case 'saveUnit':     return json(saveUnit(user, merged));
      case 'deleteUnit':    return json(deleteUnit(user, merged));
      case 'deleteReading': return json(deleteReading(user, merged));
      case 'getFeedback':   return json(getFeedback(user));
      default:             return json({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch(err) { return json({ ok: false, error: err.message }); }
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── AUTH ────────────────────────────────────────────────────────────
function authPin(body) {
  const { pin, name } = body;
  if (!pin) return { ok: false, error: 'PIN required' };
  if (!/^\d{6}$/.test(pin)) return { ok: false, error: 'PIN must be 6 digits' };

  const sheet = getSheet(SHEETS.USERS);
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const [uName, storedPin, role, propIds, active] = rows[i];
    if (!uName) continue;
    if (active === false || active === 'false') continue;
    if (name && uName.toLowerCase() !== name.toLowerCase()) continue;
    if (storedPin.toString() === pin) {
      const token = makeToken(uName, role);
      return {
        ok: true, token,
        user: {
          name: uName, role,
          propIds: propIds ? propIds.toString().split(',').filter(Boolean) : [],
        }
      };
    }
  }
  return { ok: false, error: 'Incorrect PIN' };
}

function makeToken(name, role) {
  const payload = `${name}|${role}|${Date.now()}|${CONFIG.TOKEN_SECRET}`;
  return Utilities.base64Encode(payload);
}

function verifyToken(token) {
  if (!token) return null;
  if (token.startsWith('local_')) return { name: 'Local', role: 'admin' };
  try {
    const decoded = Utilities.newBlob(Utilities.base64Decode(token)).getDataAsString();
    const parts   = decoded.split('|');
    if (parts.length < 4) return null;
    const [name, role, ts, secret] = parts;
    if (secret !== CONFIG.TOKEN_SECRET) return null;
    if (Date.now() - parseInt(ts) > 30 * 24 * 3600 * 1000) return null;
    return { name, role };
  } catch(e) { return null; }
}

// ── SYNC DOWN ───────────────────────────────────────────────────────
function syncDown(user, body) {
  const propSheet = getSheet(SHEETS.PROPERTIES);
  let props = propSheet.getDataRange().getValues().slice(1)
    .filter(r => r[0])
    .map(r => ({ id: r[0], name: r[1], addr: r[2], icon: r[3] }));

  if (user.role !== 'admin' && user.propIds && user.propIds.length) {
    props = props.filter(p => user.propIds.includes(p.id));
  }

  const unitSheet = getSheet(SHEETS.UNITS);
  const units = unitSheet.getDataRange().getValues().slice(1)
    .filter(r => r[0])
    .map(r => ({
      id: r[0], propId: r[1], number: r[2], name: r[3], location: r[4],
      meters: r[5] ? r[5].toString().split(',') : ['electricity']
    }));

  const rdSheet = getSheet(SHEETS.READINGS);
  const readings = rdSheet.getDataRange().getValues().slice(1)
    .filter(r => r[0])
    .map(r => ({
      id: r[0], propId: r[1], unitId: r[2], meterType: r[3],
      reading: r[4].toString(),
      date: r[5] instanceof Date
        ? Utilities.formatDate(r[5], Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : (r[5]||'').toString().slice(0,10),
      time: r[6] instanceof Date
        ? Utilities.formatDate(r[6], Session.getScriptTimeZone(), 'HH:mm')
        : (r[6]||'').toString().slice(0,5),
      notes: r[7], imageUrl: r[8] || '', aiConf: r[9], savedAt: r[10]
    }))
    .slice(-500);

  return { ok: true, props, units, readings };
}

// ── PUSH READING ────────────────────────────────────────────────────
function pushReading(user, body) {
  const r = parseParam(body.reading);
  if (!r || !r.id) return { ok: false, error: 'Reading data required' };

  const sheet = getSheet(SHEETS.READINGS);
  if (findRow(sheet, r.id, 0) >= 0) return { ok: true, duplicate: true };

  sheet.appendRow([
    r.id, r.propId, r.unitId, r.meterType,
    r.reading, r.date, r.time, r.notes || '',
    r.imageUrl || '', r.aiConf || '', r.savedAt || new Date().toISOString(),
    user.name
  ]);
  logSync(user.name, 'pushReading', r.id);
  return { ok: true };
}

// ── PUSH IMAGE ──────────────────────────────────────────────────────
function pushImage(user, body) {
  const { readingId, propId, propName, unitNumber, unitDesc, meterType, meterLabel, date, time, imageBase64, mimeType } = body;
  if (!imageBase64 || !readingId) return { ok: false, error: 'Image data required' };

  try {
    const folder = getOrCreateNestedFolder(propName || propId);

    const unitPart  = [unitNumber, unitDesc].filter(Boolean).join(' ');
    const meterPart = (meterType || 'meter').toLowerCase();
    const datePart  = formatDriveDateShort(date || '');
    const safeUnit  = (unitPart || 'unit').replace(/[/\\:*?"<>|]/g, '_').trim();
    const filename  = `${safeUnit}_${meterPart}_${datePart}.jpg`;

    const existing = folder.getFilesByName(filename);
    if (existing.hasNext()) {
      const existingFile = existing.next();
      const url = `https://drive.google.com/thumbnail?id=${existingFile.getId()}&sz=w800`;
      const rdSheet = getSheet(SHEETS.READINGS);
      const idx = findRow(rdSheet, readingId, 0);
      if (idx >= 0) {
        const existingUrl = rdSheet.getRange(idx + 1, 9).getValue();
        if (!existingUrl) rdSheet.getRange(idx + 1, 9).setValue(url);
      }
      return { ok: true, url, duplicate: true };
    }

    const blob = Utilities.newBlob(
      Utilities.base64Decode(imageBase64),
      mimeType || 'image/jpeg',
      filename
    );
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const url = `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w800`;
    const rdSheet = getSheet(SHEETS.READINGS);
    const idx = findRow(rdSheet, readingId, 0);
    if (idx >= 0) rdSheet.getRange(idx + 1, 9).setValue(url);

    logSync(user.name, 'pushImage', filename);
    return { ok: true, url };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

function formatDriveDateShort(dateStr) {
  if (!dateStr) return 'unknown';
  try {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const parts = dateStr.split('-');
    const d = parseInt(parts[2], 10);
    const m = months[parseInt(parts[1], 10) - 1] || '';
    const y = parts[0];
    return `${d}${m}${y}`;
  } catch(e) { return dateStr.replace(/-/g,''); }
}

function getOrCreateNestedFolder(propName) {
  const root = CONFIG.DRIVE_FOLDER_ID
    ? DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID)
    : DriveApp.getRootFolder();

  function getOrCreate(parent, name) {
    const iter = parent.getFoldersByName(name);
    return iter.hasNext() ? iter.next() : parent.createFolder(name);
  }

  // Structure: MeterIQ / {Property Name} — all meter photos go in one folder per property
  const appFolder = getOrCreate(root, 'MeterIQ');
  return getOrCreate(appFolder, propName || 'Unknown Property');
}

// ── FEEDBACK ────────────────────────────────────────────────────────
// saveFeedback is intentionally public (no token) so pilot users who
// haven't fully logged in can still submit feedback.
function saveFeedback(fb) {
  if (!fb || !fb.text) return { ok: false, error: 'Feedback text required' };
  try {
    const sheet = getSheet(SHEETS.FEEDBACK);
    sheet.appendRow([
      fb.id  || ('fb_' + Date.now()),
      fb.ts  || new Date().toISOString(),
      fb.user   || 'Anonymous',
      fb.screen || '—',
      fb.ver    || '—',
      fb.text,
    ]);
    logSync(fb.user || 'anon', 'saveFeedback', fb.id || '');
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

function getFeedback(user) {
  if (user.role !== 'admin' && user.role !== 'manager') {
    return { ok: false, error: 'Admin or manager only' };
  }
  try {
    const sheet = getSheet(SHEETS.FEEDBACK);
    if (sheet.getLastRow() <= 1) return { ok: true, feedback: [] };
    const rows = sheet.getDataRange().getValues().slice(1);
    const feedback = rows
      .filter(r => r[0])
      .map(r => ({
        id:     r[0],
        ts:     r[1] instanceof Date ? r[1].toISOString() : (r[1] || ''),
        user:   r[2],
        screen: r[3],
        ver:    r[4],
        text:   r[5],
      }));
    return { ok: true, feedback };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── USER MANAGEMENT ─────────────────────────────────────────────────
function getUsers(user) {
  if (user.role !== 'admin' && user.role !== 'manager') return { ok: false, error: 'Admin only' };
  const sheet = getSheet(SHEETS.USERS);
  const rows  = sheet.getDataRange().getValues().slice(1);
  const isAdmin = user.role === 'admin';
  return {
    ok: true,
    users: rows.filter(r => r[0]).map(r => ({
      name:    r[0],
      // Managers can only see PINs for inspectors, not admin/manager accounts
      pin:     (isAdmin || r[2] === 'inspector') ? (r[1] ? r[1].toString() : '') : '',
      role:    r[2],
      propIds: r[3] ? r[3].toString() : '',
      active:  r[4] !== false && r[4] !== 'false',
    }))
  };
}

function getLoginUsers() {
  try {
    const sheet = getSheet(SHEETS.USERS);
    const rows  = sheet.getDataRange().getValues().slice(1);
    return {
      ok: true,
      users: rows
        .filter(r => r[0] && r[4] !== false && r[4] !== 'false')
        .map(r => ({ name: r[0], role: r[2] }))
    };
  } catch(e) { return { ok: false, error: e.message }; }
}

function saveUser(user, body) {
  if (user.role !== 'admin') return { ok: false, error: 'Admin only' };
  const u = parseParam(body.user);
  if (!u) return { ok: false, error: 'User data required' };
  const { name, pin, role, propIds, active } = u;
  if (!name || !role) return { ok: false, error: 'Name and role required' };
  if (pin && !/^\d{6}$/.test(pin)) return { ok: false, error: 'PIN must be 6 digits' };

  const sheet = getSheet(SHEETS.USERS);
  const idx   = findRow(sheet, name, 0);
  if (idx >= 0) {
    const existingPin = sheet.getRange(idx + 1, 2).getValue();
    sheet.getRange(idx + 1, 1, 1, 5).setValues([[
      name,
      pin || existingPin,
      role,
      Array.isArray(propIds) ? propIds.join(',') : (propIds || ''),
      active !== false,
    ]]);
  } else {
    sheet.appendRow([
      name,
      pin || '000000',
      role,
      Array.isArray(propIds) ? propIds.join(',') : (propIds || ''),
      true,
    ]);
  }
  return { ok: true };
}

function deleteUser(user, body) {
  if (user.role !== 'admin') return { ok: false, error: 'Admin only' };
  const sheet = getSheet(SHEETS.USERS);
  const idx   = findRow(sheet, body.name, 0);
  if (idx < 0) return { ok: false, error: 'User not found' };
  sheet.deleteRow(idx + 1);
  return { ok: true };
}

// ── PROPERTY / UNIT MANAGEMENT ──────────────────────────────────────
function saveProperty(user, body) {
  if (user.role !== 'admin') return { ok: false, error: 'Admin only' };
  const p = parseParam(body.prop);
  if (!p) return { ok: false, error: 'Property data required' };
  const sheet = getSheet(SHEETS.PROPERTIES);
  const idx   = findRow(sheet, p.id, 0);
  if (p._delete) {
    if (idx >= 0) sheet.deleteRow(idx + 1);
    return { ok: true };
  }
  const row = [p.id, p.name, p.addr || '', p.icon || '🏢'];
  if (idx >= 0) sheet.getRange(idx + 1, 1, 1, 4).setValues([row]);
  else sheet.appendRow(row);
  return { ok: true };
}

function saveUnit(user, body) {
  if (user.role !== 'admin' && user.role !== 'manager') return { ok: false, error: 'Insufficient permissions' };
  const u = parseParam(body.unit);
  if (!u) return { ok: false, error: 'Unit data required' };
  const sheet  = getSheet(SHEETS.UNITS);
  const idx    = findRow(sheet, u.id, 0);
  const meters = Array.isArray(u.meters) ? u.meters.join(',') : (u.meters || 'electricity');
  const row    = [u.id, u.propId, u.number, u.name || '', u.location || '', meters];
  if (idx >= 0) sheet.getRange(idx + 1, 1, 1, 6).setValues([row]);
  else sheet.appendRow(row);
  return { ok: true };
}

function deleteUnit(user, body) {
  if (user.role !== 'admin') return { ok: false, error: 'Admin only' };
  const sheet = getSheet(SHEETS.UNITS);
  const idx   = findRow(sheet, body.unitId, 0);
  if (idx >= 0) sheet.deleteRow(idx + 1);
  return { ok: true };
}

function deleteReading(user, body) {
  if (!body.readingId) return { ok: false, error: 'readingId required' };
  const sheet = getSheet(SHEETS.READINGS);
  const idx   = findRow(sheet, body.readingId, 0);
  if (idx >= 0) sheet.deleteRow(idx + 1);
  logSync(user.name, 'deleteReading', body.readingId);
  return { ok: true };
}

// ── SHEET HELPERS ───────────────────────────────────────────────────
function getSpreadsheet() {
  return CONFIG.SHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name) {
  const ss    = getSpreadsheet();
  let   sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const headers = {
      [SHEETS.USERS]:      ['name', 'pin', 'role', 'propIds', 'active'],
      [SHEETS.PROPERTIES]: ['id', 'name', 'addr', 'icon'],
      [SHEETS.UNITS]:      ['id', 'propId', 'number', 'name', 'location', 'meters'],
      [SHEETS.READINGS]:   ['id', 'propId', 'unitId', 'meterType', 'reading', 'date', 'time', 'notes', 'imageUrl', 'aiConf', 'savedAt', 'syncedBy'],
      [SHEETS.SYNC_LOG]:   ['timestamp', 'user', 'action', 'ref'],
      [SHEETS.FEEDBACK]:   ['id', 'timestamp', 'user', 'screen', 'appVersion', 'feedback'],
    };
    if (headers[name]) {
      const hRow = sheet.getRange(1, 1, 1, headers[name].length);
      hRow.setValues([headers[name]]);
      hRow.setFontWeight('bold');
      hRow.setBackground('#f3f4f6');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function findRow(sheet, value, col) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][col] && data[i][col].toString().toLowerCase() === value.toString().toLowerCase()) return i;
  }
  return -1;
}

function logSync(name, action, ref) {
  try { getSheet(SHEETS.SYNC_LOG).appendRow([new Date().toISOString(), name, action, ref]); }
  catch(e) {}
}

// ── ONE-TIME SETUP ──────────────────────────────────────────────────
function resetUsers() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEETS.USERS);
  if (sheet) ss.deleteSheet(sheet);
  const fresh = getSheet(SHEETS.USERS);
  fresh.appendRow(['admin', '000000', 'admin', 'p_mbc1,p_mbc2', true]);
  return { ok: true, message: 'Users reset. Admin PIN: 000000' };
}

function setupSheets() {
  Object.values(SHEETS).forEach(n => getSheet(n));
  return { ok: true, message: 'Sheet tabs initialised.' };
}
