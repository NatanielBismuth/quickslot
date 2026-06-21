'use strict';

// Storage abstraction with two interchangeable backends:
//   - Postgres   (used in production when DATABASE_URL is set — e.g. Neon free tier)
//   - JSON files (default for local dev — zero config, zero dependencies)
// Both expose the same async API so server.js doesn't care which is active.

const fs = require('fs');
const path = require('path');

const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const DEFAULT_CONFIG = {
  businessName: 'QuickSlot',
  workingDays: [1, 2, 3, 4, 5], // 0 = Sunday ... 6 = Saturday
  startHour: 9,
  endHour: 17,
  slotMinutes: 30,
  maxDaysAhead: 30,
  timezone: SERVER_TZ, // IANA tz the slots are defined in
};

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
      return { ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) };
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
      all.push(b);
      writeJSON(BOOKINGS_FILE, all);
      return b;
    },
    async cancelBooking(id) {
      const all = readJSON(BOOKINGS_FILE, []);
      const i = all.findIndex((x) => x.id === id);
      if (i === -1) return null;
      all[i].status = 'cancelled';
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
      const r = await pool.query('SELECT 1 FROM app_config WHERE id = 1');
      if (r.rowCount === 0) {
        await pool.query('INSERT INTO app_config (id, data) VALUES (1, $1)', [DEFAULT_CONFIG]);
      }
    },
    async getConfig() {
      const r = await pool.query('SELECT data FROM app_config WHERE id = 1');
      return r.rowCount ? { ...DEFAULT_CONFIG, ...r.rows[0].data } : { ...DEFAULT_CONFIG };
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
      await pool.query('INSERT INTO bookings (id, data) VALUES ($1, $2)', [b.id, b]);
      return b;
    },
    async cancelBooking(id) {
      const r = await pool.query('SELECT data FROM bookings WHERE id = $1', [id]);
      if (r.rowCount === 0) return null;
      const data = { ...r.rows[0].data, status: 'cancelled' };
      await pool.query('UPDATE bookings SET data = $2 WHERE id = $1', [id, data]);
      return data;
    },
    async deleteBooking(id) {
      const r = await pool.query('DELETE FROM bookings WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
  };
}

function createStore() {
  if (process.env.DATABASE_URL) return createPgStore(process.env.DATABASE_URL);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  return createFileStore(dataDir);
}

module.exports = { createStore, DEFAULT_CONFIG, SERVER_TZ };
