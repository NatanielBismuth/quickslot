'use strict';

const DAYS_VISIBLE = 5;
const VISITOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const LANG_KEY = 'quickslot_lang';

const $ = (id) => document.getElementById(id);

// ---------- translations ----------
const I18N = {
  he: {
    docTitle: 'קביעת תור',
    title: 'קביעת תור',
    subtitle: 'אין צורך בחשבון — בחרו זמן שמתאים לכם.',
    step1: 'בחירת תאריך',
    step2: 'בחירת שעה',
    step3: 'הפרטים שלכם',
    noSlots: 'אין שעות פנויות ביום זה. נסו תאריך אחר.',
    nameLabel: 'שם מלא',
    notesLabel: 'הערות',
    optional: '(אופציונלי)',
    namePh: 'ישראל ישראלי',
    notesPh: 'משהו שכדאי שנדע?',
    confirm: 'אישור הזמנה',
    doneTitle: 'נקבע התור!',
    doneNote: 'התור שלכם נשמר. נתראה!',
    another: 'קביעת תור נוסף',
    loading: 'טוען…',
    booking: 'מזמינים…',
    tzDiff: (vtz, btz) => `השעות מוצגות לפי אזור הזמן שלכם (${vtz}). העסק פועל לפי ${btz}.`,
    tzSame: (vtz) => `השעות מוצגות לפי ${vtz}.`,
    summary: (date, time, tz) => `📅 <strong>${date}</strong> בשעה <strong>${time}</strong> <span class="muted">(${tz})</span>`,
    done: (name, date, time, tz) => `${name}, התור שלכם נקבע ל־<strong>${date}</strong> בשעה <strong>${time}</strong> <span class="muted">(${tz})</span>.`,
    errName: 'נא להזין שם מלא',
    errTaken: 'מצטערים, השעה הזו כבר נתפסה.',
    errGeneric: 'לא ניתן להשלים את ההזמנה',
  },
  en: {
    docTitle: 'Book an Appointment',
    title: 'Book an appointment',
    subtitle: 'No account needed — pick a time that works for you.',
    step1: 'Choose a date',
    step2: 'Choose a time',
    step3: 'Your details',
    noSlots: 'No open times for this day. Try another date.',
    nameLabel: 'Full name',
    notesLabel: 'Notes',
    optional: '(optional)',
    namePh: 'Jane Doe',
    notesPh: 'Anything we should know?',
    confirm: 'Confirm booking',
    doneTitle: "You're booked!",
    doneNote: 'Your appointment is saved — see you then!',
    another: 'Book another time',
    loading: 'Loading…',
    booking: 'Booking…',
    tzDiff: (vtz, btz) => `Times shown in your timezone (${vtz}). Business runs on ${btz}.`,
    tzSame: (vtz) => `Times shown in ${vtz}.`,
    summary: (date, time, tz) => `📅 <strong>${date}</strong> at <strong>${time}</strong> <span class="muted">(${tz})</span>`,
    done: (name, date, time, tz) => `${name}, your appointment is set for <strong>${date}</strong> at <strong>${time}</strong> <span class="muted">(${tz})</span>.`,
    errName: 'Name is required',
    errTaken: 'Sorry, that slot is no longer available.',
    errGeneric: 'Could not complete booking',
  },
};

const state = {
  config: null,
  lang: localStorage.getItem(LANG_KEY) || 'he',
  weekOffset: 0,
  selectedDate: null,
  selectedTime: null,
  selectedInstant: null,
  businessTz: VISITOR_TZ,
};

function t(key, ...args) {
  const v = I18N[state.lang][key];
  return typeof v === 'function' ? v(...args) : v;
}
function locale() { return state.lang === 'he' ? 'he-IL' : 'en-US'; }

function pad(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

// ---- timezone conversion (mirrors server logic) ----
function tzOffsetMs(timeZone, date) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const m = {};
    for (const p of dtf.formatToParts(date)) m[p.type] = p.value;
    const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day,
      m.hour === '24' ? 0 : +m.hour, +m.minute, +m.second);
    return asUTC - date.getTime();
  } catch (e) { return 0; }
}
function slotInstant(dateStr, time, businessTz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(guess - tzOffsetMs(businessTz, new Date(guess)));
}
function fmtInTz(instant, tz) {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: tz, hour: 'numeric', minute: '2-digit',
    hour12: state.lang !== 'he',
  }).format(instant);
}
function dateInTz(instant, tz) {
  const m = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant)) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day}`;
}
function prettyDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return new Intl.DateTimeFormat(locale(), { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

// ---------- language ----------
function applyStaticText() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'he' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (I18N[state.lang][key]) el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph');
    if (I18N[state.lang][key]) el.setAttribute('placeholder', t(key));
  });
  document.title = state.config && state.config.businessName
    ? `${t('title')} · ${state.config.businessName}`
    : t('docTitle');
  document.querySelectorAll('.lang-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.lang === state.lang));
  // chevrons point the intuitive way per writing direction
  const prev = $('prevWeek'), next = $('nextWeek');
  if (prev && next) {
    prev.textContent = state.lang === 'he' ? '›' : '‹';
    next.textContent = state.lang === 'he' ? '‹' : '›';
  }
}

function setLang(lang) {
  if (!I18N[lang]) return;
  state.lang = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyStaticText();
  renderDays();
  // re-render the open time list / summaries if a date is already chosen
  if (state.selectedDate) selectDate(state.selectedDate);
}

// ---------- flow ----------
async function init() {
  state.config = await fetch('/api/config').then((r) => r.json());
  if (state.config.businessName) $('brand').textContent = state.config.businessName;
  applyStaticText();
  renderDays();

  $('prevWeek').onclick = () => {
    if (state.weekOffset > 0) { state.weekOffset--; renderDays(); }
  };
  $('nextWeek').onclick = () => {
    if ((state.weekOffset + 1) * DAYS_VISIBLE <= state.config.maxDaysAhead) {
      state.weekOffset++;
      renderDays();
    }
  };
  $('bookingForm').onsubmit = submitBooking;
  $('bookAnother').onclick = resetFlow;
  document.querySelectorAll('.lang-btn').forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
}

function renderDays() {
  const container = $('days');
  container.innerHTML = '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dowFmt = new Intl.DateTimeFormat(locale(), { weekday: 'short' });
  const monFmt = new Intl.DateTimeFormat(locale(), { month: 'short' });

  for (let i = 0; i < DAYS_VISIBLE; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + state.weekOffset * DAYS_VISIBLE + i);
    const dateStr = toDateStr(d);

    const daysAhead = Math.round((d - today) / 86400000);
    const isWorking = state.config.workingDays.includes(d.getDay());
    const tooFar = daysAhead > state.config.maxDaysAhead;
    const disabled = !isWorking || tooFar;

    const el = document.createElement('div');
    el.className = 'day' + (disabled ? ' disabled' : '') + (dateStr === state.selectedDate ? ' active' : '');
    el.innerHTML = `<div class="dow">${dowFmt.format(d)}</div><div class="dnum">${d.getDate()}</div><div class="mon">${monFmt.format(d)}</div>`;
    if (!disabled) el.onclick = () => selectDate(dateStr);
    container.appendChild(el);
  }
  updateNav();
}

// disable the back arrow at "today" and the forward arrow past the booking horizon
function updateNav() {
  const atStart = state.weekOffset === 0;
  const nextWindowStart = (state.weekOffset + 1) * DAYS_VISIBLE;
  const atEnd = nextWindowStart > state.config.maxDaysAhead;
  $('prevWeek').classList.toggle('disabled', atStart);
  $('nextWeek').classList.toggle('disabled', atEnd);
}

async function selectDate(dateStr) {
  state.selectedDate = dateStr;
  state.selectedTime = null;
  renderDays();
  $('step-time').classList.remove('hidden');
  $('step-details').classList.add('hidden');
  $('step-done').classList.add('hidden');
  $('selectedDateLabel').textContent = '· ' + prettyDate(dateStr);

  const slotsEl = $('slots');
  slotsEl.innerHTML = `<p class="empty">${t('loading')}</p>`;

  const data = await fetch('/api/slots?date=' + encodeURIComponent(dateStr)).then((r) => r.json());
  slotsEl.innerHTML = '';
  state.businessTz = data.timezone || VISITOR_TZ;

  const tzNote = $('tzNote');
  tzNote.textContent = state.businessTz !== VISITOR_TZ
    ? t('tzDiff', VISITOR_TZ, state.businessTz)
    : t('tzSame', VISITOR_TZ);
  tzNote.classList.remove('hidden');

  if (!data.slots || data.slots.length === 0) {
    $('noSlots').classList.remove('hidden');
    return;
  }
  $('noSlots').classList.add('hidden');

  for (const time of data.slots) {
    const instant = slotInstant(dateStr, time, state.businessTz);
    const el = document.createElement('div');
    el.className = 'slot';
    let label = fmtInTz(instant, VISITOR_TZ);
    const shiftDays = Math.round(
      (new Date(dateInTz(instant, VISITOR_TZ) + 'T00:00:00') -
       new Date(dateStr + 'T00:00:00')) / 86400000
    );
    if (shiftDays !== 0) label += ` (${shiftDays > 0 ? '+' : ''}${shiftDays}d)`;
    el.textContent = label;
    el.onclick = () => selectTime(time, instant, el);
    slotsEl.appendChild(el);
  }
  $('step-time').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function selectTime(time, instant, el) {
  state.selectedTime = time;
  state.selectedInstant = instant;
  document.querySelectorAll('.slot').forEach((s) => s.classList.remove('active'));
  el.classList.add('active');

  const shown = fmtInTz(instant, VISITOR_TZ);
  $('step-details').classList.remove('hidden');
  $('summary').innerHTML = t('summary', prettyDate(state.selectedDate), shown, VISITOR_TZ);
  $('formError').classList.add('hidden');
  $('step-details').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function localizeError(serverMsg) {
  if (/no longer available/i.test(serverMsg)) return t('errTaken');
  if (/name is required/i.test(serverMsg)) return t('errName');
  return serverMsg || t('errGeneric');
}

async function submitBooking(e) {
  e.preventDefault();
  const btn = $('submitBtn');
  const errEl = $('formError');
  errEl.classList.add('hidden');

  const payload = {
    name: $('name').value.trim(),
    notes: $('notes').value.trim(),
    date: state.selectedDate,
    time: state.selectedTime,
  };

  btn.disabled = true;
  btn.textContent = t('booking');

  try {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'err');

    const shownTime = state.selectedInstant ? fmtInTz(state.selectedInstant, VISITOR_TZ) : payload.time;
    $('doneSummary').innerHTML = t('done', payload.name, prettyDate(payload.date), shownTime, VISITOR_TZ);
    ['step-date', 'step-time', 'step-details'].forEach((s) => $(s).classList.add('hidden'));
    $('step-done').classList.remove('hidden');
    $('step-done').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    errEl.textContent = localizeError(err.message);
    errEl.classList.remove('hidden');
    if (/no longer available/i.test(err.message) && state.selectedDate) selectDate(state.selectedDate);
  } finally {
    btn.disabled = false;
    btn.textContent = t('confirm');
  }
}

function resetFlow() {
  state.selectedDate = null;
  state.selectedTime = null;
  state.selectedInstant = null;
  $('bookingForm').reset();
  applyStaticText(); // restore placeholders after reset
  ['step-time', 'step-details', 'step-done'].forEach((s) => $(s).classList.add('hidden'));
  $('step-date').classList.remove('hidden');
  renderDays();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

init();
