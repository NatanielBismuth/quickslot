'use strict';

// Storage abstraction with two interchangeable backends:
//   - Postgres   (used in production when DATABASE_URL is set — e.g. Neon free tier)
//   - JSON files (default for local dev — zero config, zero dependencies)
// Both expose the same async API so server.js doesn't care which is active.

const fs = require('fs');
const path = require('path');

const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// Per-day opening hours. Keys 0=Sunday … 6=Saturday.
// Each day is { open: true, start: 'HH:MM', end: 'HH:MM' } or { open: false }.
const DEFAULT_HOURS = {
  0: { open: true, start: '09:00', end: '17:00' },
  1: { open: true, start: '09:00', end: '17:00' },
  2: { open: true, start: '09:00', end: '17:00' },
  3: { open: true, start: '09:00', end: '17:00' },
  4: { open: true, start: '09:00', end: '17:00' },
  5: { open: false },
  6: { open: false },
};

const DEFAULT_CONFIG = {
  businessName: 'QuickSlot',
  slotMinutes: 30,
  maxDaysAhead: 30,
  timezone: SERVER_TZ, // IANA tz the slots are defined in
  hours: DEFAULT_HOURS,
};

// Normalize a stored config to the current shape. Migrates legacy configs that
// used workingDays + startHour/endHour into the per-day `hours` structure.
function normalizeConfig(stored) {
  const s = stored || {};
  const cfg = {
    businessName: s.businessName != null ? s.businessName : DEFAULT_CONFIG.businessName,
    slotMinutes: s.slotMinutes != null ? s.slotMinutes : DEFAULT_CONFIG.slotMinutes,
    maxDaysAhead: s.maxDaysAhead != null ? s.maxDaysAhead : DEFAULT_CONFIG.maxDaysAhead,
    timezone: s.timezone != null ? s.timezone : DEFAULT_CONFIG.timezone,
  };
  if (s.hours && typeof s.hours === 'object') {
    cfg.hours = s.hours;
  } else {
    const pad2 = (n) => String(n).padStart(2, '0');
    const wd = Array.isArray(s.workingDays) ? s.workingDays : [0, 1, 2, 3, 4];
    const start = Number.isInteger(s.startHour) ? pad2(s.startHour) + ':00' : '09:00';
    const end = Number.isInteger(s.endHour)
      ? (s.endHour >= 24 ? '23:59' : pad2(s.endHour) + ':00')
      : '17:00';
    const hours = {};
    for (let d = 0; d < 7; d++) hours[d] = wd.includes(d) ? { open: true, start, end } : { open: false };
    cfg.hours = hours;
  }
  return cfg;
}

// ---------- file backend ----------
function createFileStore(dataDir) {
  const BOOKINGS_FILE = path.join(dataDir, 'bookings.json');
  const CONFIG_FILE = path.join(dataDir, 'config.json');

  const readJSON = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
  };
  const writeJSON = (file, data) => {
    // temp-write + rename = atomic; a crash mid-write can't corrupt the file.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };

  return {
    kind: 'file',
    label: dataDir,
    async init() {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      if (!fs.existsSync(BOOKINGS_FILE)) writeJSON(BOOKINGS_FILE, []);
      if (!fs.existsSync(CONFIG_FILE)) writeJSON(CONFIG_FILE, DEFAULT_CONFIG);
    },
    async getConfig() {
      return normalizeConfig(readJSON(CONFIG_FILE, {}));
    },
    async saveConfig(cfg) {
      writeJSON(CONFIG_FILE, cfg);
      return cfg;
    },
    async listBookings() {
      return readJSON(BOOKINGS_FILE, []);
    },
    async addBooking(b) {
      const all = readJSON(BOOKINGS_FILE, []);
      // Atomic slot guard: reject if an active booking already holds this slot.
      // This function has no `await` inside, so the read-check-write runs to
      // completion without yielding the event loop — concurrent requests that
      // both passed the availability check can't both land here.
      const clash = all.some(
        (x) => x.date === b.date && x.time === b.time && x.status !== 'cancelled'
      );
      if (clash) return null;
      all.push(b);
      writeJSON(BOOKINGS_FILE, all);
      return b;
    },
    async cancelBooking(id) {
      const all = readJSON(BOOKINGS_FILE, []);
      const i = all.findIndex((x) => x.id === id);
      if (i === -1) return null;
      all[i].status = 'cancelled';
      all[i].cancelledAt = new Date().toISOString();
      writeJSON(BOOKINGS_FILE, all);
      return all[i];
    },
    async deleteBooking(id) {
      const all = readJSON(BOOKINGS_FILE, []);
      const remaining = all.filter((x) => x.id !== id);
      if (remaining.length === all.length) return false;
      writeJSON(BOOKINGS_FILE, remaining);
      return true;
    },
    // Keep-warm/health probe. No DB in file mode — just report healthy.
    async ping() {
      return { ok: true };
    },
  };
}

// ---------- postgres backend ----------
function createPgStore(connectionString) {
  const { Pool } = require('pg'); // lazy require so local dev needs no dependency
  // Managed providers (Neon/Render/Supabase) require TLS; local pg usually doesn't.
  const noSsl = /localhost|127\.0\.0\.1|sslmode=disable/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: noSsl ? false : { rejectUnauthorized: false },
  });

  return {
    kind: 'postgres',
    label: 'postgres',
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS app_config (id INT PRIMARY KEY, data JSONB NOT NULL)');
      await pool.query('CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())');
      // Enforce one active booking per (date, time) at the DB level so a race
      // between the availability check and the insert can't double-book a slot.
      // Cancelled bookings are excluded, so a slot frees up when cancelled.
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_slot
         ON bookings ((data->>'date'), (data->>'time'))
         WHERE (data->>'status') <> 'cancelled'`
      );
      const r = await pool.query('SELECT 1 FROM app_config WHERE id = 1');
      if (r.rowCount === 0) {
        await pool.query('INSERT INTO app_config (id, data) VALUES (1, $1)', [DEFAULT_CONFIG]);
      }
    },
    async getConfig() {
      const r = await pool.query('SELECT data FROM app_config WHERE id = 1');
      return normalizeConfig(r.rowCount ? r.rows[0].data : {});
    },
    async saveConfig(cfg) {
      await pool.query(
        'INSERT INTO app_config (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1',
        [cfg]
      );
      return cfg;
    },
    async listBookings() {
      const r = await pool.query("SELECT data FROM bookings ORDER BY (data->>'date'), (data->>'time')");
      return r.rows.map((x) => x.data);
    },
    async addBooking(b) {
      try {
        await pool.query('INSERT INTO bookings (id, data) VALUES ($1, $2)', [b.id, b]);
        return b;
      } catch (e) {
        // 23505 = unique_violation → the slot was taken by a concurrent request.
        if (e && e.code === '23505') return null;
        throw e;
      }
    },
    async cancelBooking(id) {
      const r = await pool.query('SELECT data FROM bookings WHERE id = $1', [id]);
      if (r.rowCount === 0) return null;
      const data = { ...r.rows[0].data, status: 'cancelled', cancelledAt: new Date().toISOString() };
      await pool.query('UPDATE bookings SET data = $2 WHERE id = $1', [id, data]);
      return data;
    },
    async deleteBooking(id) {
      const r = await pool.query('DELETE FROM bookings WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
    // Keep-warm/health probe: a trivial query that wakes/keeps Neon's compute warm.
    async ping() {
      await pool.query('SELECT 1');
      return { ok: true };
    },
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return createPgStore(process.env.DATABASE_URL);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  return createFileStore(dataDir);
}

module.exports = { createStore, DEFAULT_CONFIG, SERVER_TZ };
