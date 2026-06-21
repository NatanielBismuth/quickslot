'use strict';

// Hebrew weekday letters, Sunday → Saturday
const DOW_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'שבת'];
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'quickslot_admin_token';
const LOCALE = 'he-IL';

// localized strings used in dynamic places
const T = {
  noBookings: 'אין תורים עדיין.',
  active: (n) => `· ${n} פעילים`,
  thWhen: 'מתי', thWho: 'מי', thNotes: 'הערות', thStatus: 'סטטוס',
  cancel: 'ביטול',
  del: 'מחיקה',
  confirmCancel: 'לבטל את התור? המשבצת תתפנה מחדש.',
  confirmDelete: 'למחוק את התור לצמיתות? לא ניתן לשחזר.',
  confirmed: 'מאושר', cancelled: 'מבוטל',
  saveFail: 'השמירה נכשלה',
  loginFail: 'הכניסה נכשלה',
  sessionExpired: 'פג תוקף החיבור — יש להתחבר מחדש.',
};

let workingDays = [];

function pad(n) { return String(n).padStart(2, '0'); }
function prettyDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}
function formatTime(t) {
  const d = new Date('2000-01-01T' + t + ':00');
  return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

// authenticated fetch — redirects to login on 401
async function authFetch(url, opts = {}) {
  const headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + getToken() });
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
    throw new Error(T.sessionExpired);
  }
  return res;
}

// ---------- timezones ----------
function tzList() {
  if (typeof Intl.supportedValuesOf === 'function') {
    try { return Intl.supportedValuesOf('timeZone'); } catch (e) {}
  }
  // fallback shortlist
  return ['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
    'Europe/London','Europe/Paris','Europe/Berlin','Asia/Jerusalem','Asia/Dubai','Asia/Kolkata',
    'Asia/Singapore','Asia/Tokyo','Australia/Sydney'];
}

function populateTimezones(selected) {
  const sel = $('timezone');
  sel.innerHTML = '';
  for (const tz of tzList()) {
    const o = document.createElement('option');
    o.value = tz; o.textContent = tz;
    if (tz === selected) o.selected = true;
    sel.appendChild(o);
  }
}

// ---------- login ----------
function showLogin() {
  $('adminCard').classList.add('hidden');
  $('loginCard').classList.remove('hidden');
}
function showAdmin() {
  $('loginCard').classList.add('hidden');
  $('adminCard').classList.remove('hidden');
  loadConfig();
  loadBookings();
}

async function doLogin(e) {
  e.preventDefault();
  const err = $('loginError');
  err.classList.add('hidden');
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('adminPassword').value }),
  });
  const data = await res.json();
  if (!res.ok) {
    err.textContent = translateServerError(data.error) || T.loginFail;
    err.classList.remove('hidden');
    return;
  }
  localStorage.setItem(TOKEN_KEY, data.token);
  $('adminPassword').value = '';
  showAdmin();
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

// ---------- config ----------
async function loadConfig() {
  const c = await fetch('/api/config').then((r) => r.json());
  $('businessName').value = c.businessName || '';
  $('startHour').value = c.startHour;
  $('endHour').value = c.endHour;
  $('slotMinutes').value = c.slotMinutes;
  $('maxDaysAhead').value = c.maxDaysAhead;
  populateTimezones(c.timezone);
  workingDays = [...c.workingDays];
  renderDaysPick();
}

function renderDaysPick() {
  const wrap = $('daysPick');
  wrap.innerHTML = '';
  DOW_HE.forEach((label, idx) => {
    const el = document.createElement('div');
    el.className = 'daychip' + (workingDays.includes(idx) ? ' on' : '');
    el.textContent = label;
    el.onclick = () => {
      if (workingDays.includes(idx)) workingDays = workingDays.filter((d) => d !== idx);
      else workingDays.push(idx);
      renderDaysPick();
    };
    wrap.appendChild(el);
  });
}

async function saveConfig(e) {
  e.preventDefault();
  const err = $('configError');
  err.classList.add('hidden');
  const payload = {
    businessName: $('businessName').value.trim(),
    workingDays: workingDays.sort((a, b) => a - b),
    startHour: parseInt($('startHour').value, 10),
    endHour: parseInt($('endHour').value, 10),
    slotMinutes: parseInt($('slotMinutes').value, 10),
    maxDaysAhead: parseInt($('maxDaysAhead').value, 10),
    timezone: $('timezone').value,
  };
  let res;
  try {
    res = await authFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { return; }
  const data = await res.json();
  if (!res.ok) {
    err.textContent = translateServerError(data.error) || T.saveFail;
    err.classList.remove('hidden');
    return;
  }
  const msg = $('savedMsg');
  msg.classList.remove('hidden');
  setTimeout(() => msg.classList.add('hidden'), 1800);
}

// ---------- bookings ----------
async function loadBookings() {
  let res;
  try { res = await authFetch('/api/bookings'); } catch (e) { return; }
  const bookings = await res.json();
  const active = bookings.filter((b) => b.status !== 'cancelled');
  $('count').textContent = T.active(active.length);
  const wrap = $('bookingsWrap');

  if (bookings.length === 0) {
    wrap.innerHTML = `<p class="empty">${T.noBookings}</p>`;
    return;
  }

  let rows = '';
  for (const b of bookings) {
    const statusLabel = b.status === 'cancelled' ? T.cancelled : T.confirmed;
    let actions = '';
    if (b.status === 'confirmed') {
      actions += `<button class="link-btn" data-act="cancel" data-id="${b.id}">${T.cancel}</button> `;
    }
    actions += `<button class="link-btn danger" data-act="delete" data-id="${b.id}">${T.del}</button>`;
    rows += `<tr>
      <td>${prettyDate(b.date)}<br><span class="muted">${formatTime(b.time)}</span></td>
      <td>${esc(b.name)}</td>
      <td>${b.notes ? esc(b.notes) : '<span class="muted">—</span>'}</td>
      <td><span class="badge ${b.status}">${statusLabel}</span></td>
      <td>${actions}</td>
    </tr>`;
  }
  wrap.innerHTML = `<table class="admin-table">
    <thead><tr><th>${T.thWhen}</th><th>${T.thWho}</th><th>${T.thNotes}</th><th>${T.thStatus}</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>`;

  wrap.querySelectorAll('.link-btn').forEach((btn) => {
    btn.onclick = async () => {
      const hard = btn.dataset.act === 'delete';
      if (!confirm(hard ? T.confirmDelete : T.confirmCancel)) return;
      const url = '/api/bookings/' + btn.dataset.id + (hard ? '?purge=1' : '');
      try {
        await authFetch(url, { method: 'DELETE' });
      } catch (e) { return; }
      loadBookings();
    };
  });
}

// map known server error strings to Hebrew
function translateServerError(msg) {
  if (!msg) return '';
  if (/incorrect password/i.test(msg)) return 'סיסמה שגויה';
  const tooMany = msg.match(/try again in (\d+) min/i);
  if (tooMany) return `יותר מדי ניסיונות. נסו שוב בעוד ${tooMany[1]} דקות.`;
  if (/end hour must be after/i.test(msg)) return 'שעת הסיום חייבת להיות אחרי שעת ההתחלה';
  if (/unknown timezone/i.test(msg)) return 'אזור זמן לא מוכר';
  if (/unauthorized/i.test(msg)) return T.sessionExpired;
  return msg;
}

// ---------- boot ----------
$('loginForm').onsubmit = doLogin;
$('logoutBtn').onclick = logout;
$('configForm').onsubmit = saveConfig;

if (getToken()) {
  // verify token still valid by attempting to load bookings
  authFetch('/api/bookings').then(() => showAdmin()).catch(() => showLogin());
} else {
  showLogin();
}
