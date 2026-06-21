# QuickSlot — appointment scheduler (no login)

A Calendly-style booking app. Visitors pick a date and an open time slot and book
with just their name and email — no account required. An admin page lets the owner
set availability and view/cancel bookings.

## Run

```bash
cd ~/AppointmentSchedualer
ADMIN_PASSWORD=yourpassword PORT=4000 npm start    # or: node server.js
```

Then open:
- Booking page: http://localhost:4000
- Admin panel:  http://localhost:4000/admin

No dependencies — pure Node.js. Data is stored as JSON in `./data/`.

### Environment variables
- `PORT` — port to listen on (default `3000`).
- `ADMIN_PASSWORD` — password for the admin panel (default `admin` — a warning is printed if unset; change it before exposing publicly).

### Admin login
The admin panel (`/admin`) requires the password above. On login the server issues a
12-hour session token (stored in the browser's localStorage); the admin API endpoints
require it as a `Bearer` token. The public booking endpoints need no auth.

### Timezones
Slots are defined in the **business timezone** (set in the admin panel; defaults to the
server's timezone). Visitors see every time converted to **their own** timezone, with a
note showing both. Conversion is DST-aware. A slot that lands on a different calendar day
in the visitor's timezone is flagged (e.g. `10:00 PM (+1d)`).

## Deploy — 100% free (Render free tier + Neon free Postgres)

Storage automatically switches to **Postgres** when `DATABASE_URL` is set, so data
survives restarts/redeploys even though Render's free web service has an ephemeral
filesystem. Locally (no `DATABASE_URL`) it keeps using JSON files — zero config.

**1. Create a free Postgres database (Neon)**
- Sign up at <https://neon.tech> (free tier, no credit card, no time limit).
- Create a project and copy the **connection string** (`postgresql://…`). Use the
  *pooled* connection string if offered.

**2. Push this folder to a GitHub repo.**

**3. Deploy on Render**
- <https://render.com> → **New → Blueprint** → select the repo (it reads `render.yaml`).
- When prompted, set:
  - `DATABASE_URL` → the Neon connection string
  - `ADMIN_PASSWORD` → a strong secret
- Deploy. Render gives you an HTTPS URL automatically. The app creates its own tables
  on first boot. Open `/admin` to set your business name, hours, and timezone.

> Cost: **$0**. Render's free web service spins down after ~15 min of inactivity, so the
> first visit after idle takes ~30–60s to wake up. Bookings are never lost (they live in
> Neon, not on the server's disk).

**Railway** works the same way: deploy the repo, add a Postgres plugin (it sets
`DATABASE_URL` for you), and set `ADMIN_PASSWORD`.

### Environment variables
| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection string. **If set → Postgres backend** (production). If unset → local JSON files. |
| `ADMIN_PASSWORD` | admin panel password (**required** in prod) |
| `DATA_DIR` | where JSON files live in file mode (default `./data`); ignored when `DATABASE_URL` is set |
| `PORT` / `HOST` | set automatically by the platform; default `3000` / `0.0.0.0` |

### Production safeguards built in
- **HTTPS** via the platform (automatic on Render/Railway).
- **Durable storage** — Postgres in production; survives restarts.
- **Login rate-limiting** — 5 failed attempts per IP → 15-minute lockout.
- **Atomic file writes** (file mode) — temp-file + rename, so a crash can't corrupt data.

## How it works
- `server.js` — Node `http` server: serves the frontend and a small JSON API.
- `store.js` — storage layer; Postgres if `DATABASE_URL` is set, else JSON files.
- `public/` — vanilla HTML/CSS/JS frontend.
- `data/` (file mode only) — `config.json` (availability) + `bookings.json`.

## API
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/admin/login` | — | exchange password for a session token |
| GET | `/api/config` | — | availability settings |
| PUT | `/api/config` | admin | update settings |
| GET | `/api/slots?date=YYYY-MM-DD` | — | open slots for a date |
| POST | `/api/bookings` | — | create a booking |
| GET | `/api/bookings` | admin | list all bookings |
| DELETE | `/api/bookings/:id` | admin | cancel a booking |

Admin endpoints expect `Authorization: Bearer <token>` from `/api/admin/login`.

## Notes / next steps
- Double-booking is prevented server-side by re-checking slot availability on POST.
- Sessions are in-memory, so a server restart logs admins out (fine for a single instance).
- Possible additions: email confirmations, multiple staff/calendars, calendar-grid month view.
