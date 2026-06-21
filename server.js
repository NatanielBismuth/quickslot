'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore, SERVER_TZ } = require('./store');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
// token -> expiresAt (in-memory; cleared on restart)
const sessions = new Map();

// brute-force protection for the admin login (in-memory, per-IP)
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 1000 * 60 * 15; // 15 minutes
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

// data layer: Postgres if DATABASE_URL is set, else local JSON files
const store = createStore();

// ---------- timezone helpers ----------
// Offset (ms) of an IANA timezone at a given instant: tzWallClock - UTC.
function tzOffsetMs(timeZone, date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const m = {};
    for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
    const asUTC = Date.UTC(
      +m.year, +m.month - 1, +m.day,
      m.hour === '24' ? 0 : +m.hour, +m.minute, +m.second
    );
    return asUTC - date.getTime();
  } catch (e) {
    return 0; // unknown tz → treat as UTC
  }
}

// Convert a wall-clock date/time in `timeZone` to the absolute UTC instant.
function zonedToInstant(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // correct using the offset at that guessed instant
  const offset = tzOffsetMs(timeZone, new Date(guess));
  return guess - offset;
}

// ---------- auto-cleanup ----------
// A booking is purged 24h after it ends: either 24h past its appointment time,
// or (if cancelled) 24h after it was cancelled — whichever applies.
const RETENTION_MS = 24 * 60 * 60 * 1000;
const PURGE_THROTTLE_MS = 10 * 60 * 1000; // run at most once per 10 min
let lastPurge = 0;

async function purgeExpired() {
  const config = await store.getConfig();
  const tz = config.timezone || SERVER_TZ;
  const bookings = await store.listBookings();
  const nowMs = Date.now();

  const expired = bookings.filter((b) => {
    const apptPassed = zonedToInstant(b.date, b.time, tz) + RETENTION_MS <= nowMs;
    const cancelledExpired =
      b.status === 'cancelled' &&
      b.cancelledAt &&
      Date.parse(b.cancelledAt) + RETENTION_MS <= nowMs;
    return apptPassed || cancelledExpired;
  });

  for (const b of expired) await store.deleteBooking(b.id);
  if (expired.length) console.log(`Auto-purged ${expired.length} expired booking(s)`);
  return expired.length;
}

// Throttled trigger run on incoming requests, so cleanup still happens on a
// free host that sleeps when idle (the hourly timer below won't fire while asleep).
function maybePurge() {
  if (Date.now() - lastPurge < PURGE_THROTTLE_MS) return;
  lastPurge = Date.now();
  purgeExpired().catch((e) => console.error('purge failed:', e.message));
}

// ---------- domain logic ----------
function pad(n) {
  return String(n).padStart(2, '0');
}

// Returns "HH:MM" slot strings for a given date based on config,
// excluding already-booked slots and any slot whose instant is in the past.
async function getSlotsForDate(dateStr) {
  const config = await store.getConfig();
  const bookings = await store.listBookings();
  const tz = config.timezone || SERVER_TZ;

  const date = new Date(dateStr + 'T00:00:00');
  if (isNaN(date.getTime())) return { error: 'Invalid date' };

  const dow = date.getDay();
  if (!config.workingDays.includes(dow)) {
    return { date: dateStr, slots: [], closed: true, timezone: tz };
  }

  const takenTimes = new Set(
    bookings
      .filter((b) => b.date === dateStr && b.status !== 'cancelled')
      .map((b) => b.time)
  );

  const slots = [];
  const nowMs = Date.now();

  for (let h = config.startHour; h < config.endHour; h++) {
    for (let m = 0; m < 60; m += config.slotMinutes) {
      const time = `${pad(h)}:${pad(m)}`;
      if (takenTimes.has(time)) continue;
      // skip slots already in the past (relative to the business timezone)
      if (zonedToInstant(dateStr, time, tz) <= nowMs) continue;
      slots.push(time);
    }
  }

  return { date: dateStr, slots, closed: false, timezone: tz };
}

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- request helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel === '/admin') rel = '/admin.html';
  // prevent path traversal
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- auth ----------
function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidToken(token) {
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getToken(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function requireAdmin(req, res) {
  if (isValidToken(getToken(req))) return true;
  sendJSON(res, 401, { error: 'Unauthorized' });
  return false;
}

// real client IP, accounting for a reverse proxy (Render/Railway sit in front)
function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

// returns ms remaining if locked out, else 0
function loginLockRemaining(ip) {
  const rec = loginAttempts.get(ip);
  if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return rec.lockedUntil - Date.now();
  }
  return 0;
}

function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_LOGIN_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOGIN_WINDOW_MS;
    rec.count = 0;
  }
  loginAttempts.set(ip, rec);
}

// ---------- API routes ----------
async function handleApi(req, res, url) {
  const { pathname } = url;

  // opportunistic cleanup (throttled, fire-and-forget) so expired bookings
  // get removed even on a free host that sleeps between visits
  maybePurge();

  // POST /api/admin/login  { password } -> { token }
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const ip = clientIp(req);
    const lockMs = loginLockRemaining(ip);
    if (lockMs > 0) {
      const mins = Math.ceil(lockMs / 60000);
      return sendJSON(res, 429, { error: `Too many attempts. Try again in ${mins} min.` });
    }
    const body = await readBody(req);
    const supplied = Buffer.from(String(body.password || ''));
    const actual = Buffer.from(ADMIN_PASSWORD);
    const ok =
      supplied.length === actual.length &&
      crypto.timingSafeEqual(supplied, actual);
    if (!ok) {
      recordLoginFail(ip);
      return sendJSON(res, 401, { error: 'Incorrect password' });
    }
    loginAttempts.delete(ip); // reset on success
    return sendJSON(res, 200, { token: issueToken(), ttlMs: SESSION_TTL_MS });
  }

  // GET /api/config  (public — booking page needs name/hours/timezone)
  if (req.method === 'GET' && pathname === '/api/config') {
    const config = await store.getConfig();
    return sendJSON(res, 200, config);
  }

  // PUT /api/config  (admin)
  if (req.method === 'PUT' && pathname === '/api/config') {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const config = await store.getConfig();
    const merged = { ...config };
    if (typeof body.businessName === 'string') merged.businessName = body.businessName.slice(0, 80);
    if (Array.isArray(body.workingDays)) merged.workingDays = body.workingDays.filter((d) => d >= 0 && d <= 6);
    if (Number.isInteger(body.startHour)) merged.startHour = clamp(body.startHour, 0, 23);
    if (Number.isInteger(body.endHour)) merged.endHour = clamp(body.endHour, 1, 24);
    if (Number.isInteger(body.slotMinutes)) merged.slotMinutes = clamp(body.slotMinutes, 5, 240);
    if (Number.isInteger(body.maxDaysAhead)) merged.maxDaysAhead = clamp(body.maxDaysAhead, 1, 365);
    if (typeof body.timezone === 'string') {
      if (!isValidTimezone(body.timezone)) return sendJSON(res, 400, { error: 'Unknown timezone' });
      merged.timezone = body.timezone;
    }
    if (merged.endHour <= merged.startHour) return sendJSON(res, 400, { error: 'End hour must be after start hour' });
    await store.saveConfig(merged);
    return sendJSON(res, 200, merged);
  }

  // GET /api/slots?date=YYYY-MM-DD
  if (req.method === 'GET' && pathname === '/api/slots') {
    const dateStr = url.searchParams.get('date');
    if (!dateStr) return sendJSON(res, 400, { error: 'date is required' });
    const result = await getSlotsForDate(dateStr);
    if (result.error) return sendJSON(res, 400, result);
    return sendJSON(res, 200, result);
  }

  // POST /api/bookings
  if (req.method === 'POST' && pathname === '/api/bookings') {
    const body = await readBody(req);
    const name = (body.name || '').trim();
    const date = (body.date || '').trim();
    const time = (body.time || '').trim();
    const notes = (body.notes || '').toString().slice(0, 500);

    if (!name) return sendJSON(res, 400, { error: 'Name is required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, 400, { error: 'Invalid date' });
    if (!/^\d{2}:\d{2}$/.test(time)) return sendJSON(res, 400, { error: 'Invalid time' });

    // confirm the slot is genuinely available (prevents double-booking races)
    const avail = await getSlotsForDate(date);
    if (avail.closed || !avail.slots.includes(time)) {
      return sendJSON(res, 409, { error: 'Sorry, that slot is no longer available.' });
    }

    const booking = {
      id: crypto.randomUUID(),
      name: name.slice(0, 80),
      date,
      time,
      notes,
      status: 'confirmed',
      createdAt: new Date().toISOString(),
    };
    // addBooking is the atomic backstop: it returns null if the slot was claimed
    // by a concurrent request between the availability check above and this write.
    const created = await store.addBooking(booking);
    if (!created) {
      return sendJSON(res, 409, { error: 'Sorry, that slot is no longer available.' });
    }
    return sendJSON(res, 201, created);
  }

  // GET /api/bookings  (admin) — list confirmed/cancelled
  if (req.method === 'GET' && pathname === '/api/bookings') {
    if (!requireAdmin(req, res)) return;
    const bookings = await store.listBookings();
    const sorted = [...bookings].sort((a, b) =>
      (a.date + a.time).localeCompare(b.date + b.time)
    );
    return sendJSON(res, 200, sorted);
  }

  // DELETE /api/bookings/:id        (admin) — cancel (soft): frees slot, keeps record
  // DELETE /api/bookings/:id?purge=1 (admin) — delete (hard): removes the record entirely
  if (req.method === 'DELETE' && pathname.startsWith('/api/bookings/')) {
    if (!requireAdmin(req, res)) return;
    const id = pathname.split('/').pop();
    if (url.searchParams.get('purge') === '1') {
      const ok = await store.deleteBooking(id);
      if (!ok) return sendJSON(res, 404, { error: 'Booking not found' });
      return sendJSON(res, 200, { id, deleted: true });
    }
    const cancelled = await store.cancelBooking(id);
    if (!cancelled) return sendJSON(res, 404, { error: 'Booking not found' });
    return sendJSON(res, 200, cancelled);
  }

  return sendJSON(res, 404, { error: 'Unknown endpoint' });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    return serveStatic(res, url.pathname);
  } catch (err) {
    sendJSON(res, 400, { error: err.message || 'Bad request' });
  }
});

async function start() {
  await store.init();
  const config = await store.getConfig();
  server.listen(PORT, HOST, () => {
    console.log(`QuickSlot running → http://localhost:${PORT}  (bound ${HOST}:${PORT})`);
    console.log(`Admin panel       → http://localhost:${PORT}/admin`);
    console.log(`Storage backend   → ${store.kind} (${store.label})`);
    console.log(`Business timezone → ${config.timezone || SERVER_TZ}`);
    if (ADMIN_PASSWORD === 'admin') {
      console.warn('⚠  Using default admin password "admin". Set ADMIN_PASSWORD before exposing publicly.');
    }
  });
  // clean up expired bookings now and hourly while the process is awake
  purgeExpired().catch((e) => console.error('purge failed:', e.message));
  lastPurge = Date.now();
  setInterval(() => {
    lastPurge = Date.now();
    purgeExpired().catch((e) => console.error('purge failed:', e.message));
  }, 60 * 60 * 1000).unref();
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
