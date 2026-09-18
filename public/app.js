const app = document.getElementById('app');
const toastRegion = document.getElementById('toast-region');
const HALL_TIME_ZONE = 'Asia/Kolkata';
const HALL_LOCATION = 'Guntur, Andhra Pradesh';
const state = {
  owner: { displayName: 'Sri Square Owner', role: 'Private workspace' },
  dashboard: null,
  bookings: [],
  cash: [],
  activity: [],
  backupSchedule: { enabled: false, time: '23:00' },
  view: 'home',
  selectedBookingId: null,
  selectedDocument: null,
  calendarMonth: calendarMonthInHallTimeZone(),
  menuOpen: false,
  bookingQuery: '',
  customerQuery: '',
  bookingEvents: [],
  availability: null
};

const terms = [
  '50% advance is required to block the date. Booking amount is non-refundable; date change is subject to availability.',
  'Final billing is based on actual usage including electricity, diesel, personnel and other applicable charges.',
  'Balance payment must be cleared before the event. Damage to hall property, furniture, electrical items, washrooms, dining tables or chairs will be charged at actual cost.',
  'Hall timing is limited to the booked 12-hour period. Extra hours are subject to availability and applicable charges.',
  'Waste handling and excess cleaning charges may apply. Firecrackers, open flames and gas cylinders require management approval.',
  'Management is not responsible for parking vehicle damage or theft. Payments are accepted by Cash, UPI, Company Account or Bank Transfer.',
  'GST, if applicable, will be charged extra. Management may modify terms without notice.'
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function money(value) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value || 0));
}

function shortDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: HALL_TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
}

function datetime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: HALL_TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function hallDateParts(value = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: HALL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}
function today() { const parts = hallDateParts(); return `${parts.year}-${parts.month}-${parts.day}`; }
function calendarMonthInHallTimeZone() { const parts = hallDateParts(); return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, 1)); }
function dateTimeInput(value) { return value ? String(value).slice(0, 16) : ''; }
function localClock(value) { return value && String(value).length >= 16 ? String(value).slice(11, 16) : '—'; }
function scheduleText(booking) {
  if (!booking?.eventStartLocal || !booking?.eventEndLocal) return shortDate(booking?.eventDate);
  const startDate = booking.eventStartLocal.slice(0, 10);
  const endDate = booking.eventEndLocal.slice(0, 10);
  const end = startDate === endDate ? localClock(booking.eventEndLocal) : `${shortDate(endDate)} ${localClock(booking.eventEndLocal)}`;
  return `${shortDate(startDate)}, ${localClock(booking.eventStartLocal)} – ${end} (${booking.eventTimezone || HALL_TIME_ZONE})`;
}
function occupiedDateKeys(booking) {
  const start = booking?.eventStartLocal?.slice(0, 10) || booking?.eventDate;
  const end = booking?.eventEndLocal?.slice(0, 10) || start;
  if (!start) return [];
  const dates = [];
  for (let day = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`); day <= last; day.setUTCDate(day.getUTCDate() + 1)) dates.push(day.toISOString().slice(0, 10));
  return dates;
}
function byId(id) { return state.bookings.find((booking) => booking.id === id); }
function selectedBooking() { return byId(state.selectedBookingId); }
function fieldValue(value) { return escapeHtml(value ?? ''); }

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || 'The request could not be completed.');
    error.details = body.details;
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function toast(message, kind = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  toastRegion.append(element);
  setTimeout(() => element.remove(), 4300);
}

async function refresh() {
  const data = await api('/api/bootstrap');
  state.owner = data.owner || state.owner;
  state.dashboard = data.dashboard;
  state.bookings = data.bookings;
  state.cash = data.cash;
  state.activity = data.activity;
  state.backupSchedule = data.backupSchedule || { enabled: false, time: '23:00' };
}

function recordView(screen) {
  api('/api/actions', { method: 'POST', body: { type: 'screen.viewed', screen } }).catch(() => {});
}

async function boot() {
  app.innerHTML = '<div class="loading">Loading Sri Square Operations</div>';
  try {
    await refresh();
    render();
  } catch (error) {
    renderUnavailable(error);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function renderUnavailable(error) {
  app.innerHTML = `<main class="page"><section class="card"><h1>Sri Square is unavailable</h1><p class="muted">${escapeHtml(error.message || 'The local service could not be reached. Start the application and refresh this page.')}</p></section></main>`;
}

function render() {
  const page = pages()[state.view] || homePage;
  const content = page();
  app.innerHTML = `
    <div class="app-shell">
      ${topbar()}
      ${state.menuOpen ? sidebar() : ''}
      <main class="page">${content}</main>
    </div>`;
  bindShell();
  bindView();
}

function topbar() {
  const initials = state.owner.displayName.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase();
  return `<header class="topbar">
    <button class="menu-toggle no-print" data-action="toggle-menu" aria-label="Open navigation">☰</button>
    <div class="topbar-brand"><img src="/icon-192.png" alt="Sri Square"><div><strong>SRI SQUARE</strong><small>ACCOUNTS · GUNTUR, AP</small></div></div>
    <div class="topbar-actions no-print"><div class="profile-chip"><span class="profile-avatar">${initials}</span><span><b>${escapeHtml(state.owner.displayName)}</b>${escapeHtml(state.owner.role)}</span></div></div>
  </header>`;
}

function sidebar() {
  const links = [
    ['home', '⌂', 'Home'], ['new-booking', '＋', 'New Booking'], ['bookings', '📋', 'Bookings'], ['calendar', '📅', 'Calendar / Availability'], ['customers', '👥', 'Customers'], ['billing', '🧾', 'Customer Billing'], ['finance', '▤', 'Financial'], ['cash', '💵', 'Cash Balance'], ['backup', '⬇', 'Backup & Audit']
  ];
  return `<div class="sidebar-backdrop" data-action="close-menu"></div><aside class="sidebar no-print">
    <div class="nav-label">OPERATIONS</div>
    ${links.map(([view, icon, label]) => `<button class="nav-link ${state.view === view ? 'active' : ''}" data-view="${view}"><span class="nav-icon">${icon}</span>${label}</button>`).join('')}
  </aside>`;
}

function pageHeader(title, description, actions = '') {
  return `<header class="page-header"><div><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ''}</div>${actions ? `<div class="header-actions no-print">${actions}</div>` : ''}</header>`;
}

function homePage() {
  recordView('home');
  const d = state.dashboard;
  return `${pageHeader('Business Overview', `Your ${HALL_LOCATION} hall operations, customer balances and cash position.`, '<button class="primary" data-view="new-booking">＋ New Booking</button>')}
    <button class="calendar-shortcut no-print" data-view="calendar"><span class="shortcut-icon">📅</span><span><small>Today</small><b>${shortDate(today())}</b></span><strong>View Calendar →</strong></button>
    <section class="hero"><div><small>SRI SQUARE</small><h2>Business Overview</h2><p>Bookings · Customer Billing · Cash · Financial Reports</p></div><div class="hero-tag">MANAGE<br>TODAY<br>GROW<br>TOMORROW<i></i></div></section>
    <section class="stat-grid">
      ${stat('📅 Total Bookings', d.totalBookings, 'All active bookings')}
      ${stat('⏱ Upcoming', d.upcoming.length, 'Future events')}
      ${stat('📈 Booking Value', money(d.totalBookingValue), 'Active customer bills')}
      ${stat('👥 Balance Due', money(d.balanceDue), 'Customer pending')}
      ${stat('✓ Customer Credit', money(d.customerCredit), 'Paid beyond bill total')}
      ${stat('💳 Customer Received', money(d.customerReceived), 'Cleared advances and final payments')}
      ${stat('💵 Cash Balance', money(d.cashBalance), 'Append-only cash ledger')}
      ${stat('▤ Financial Balance', money(d.financialBalance), 'Internal event position')}
      ${stat('🧾 Total Debits', money(d.totalDebits), 'Cash expenses')}
      ${stat('⊘ Cancelled', d.cancelledBookings, 'History retained; slots freed')}
    </section>
    <h2 class="section-title">Quick Actions</h2>
    <section class="quick-grid no-print">
      ${quick('new-booking', '＋', 'New Booking', 'Create a booking')}${quick('customers', '👥', 'Customers', 'Contact details')}${quick('billing', '🧾', 'Final Bill', 'Customer billing')}${quick('finance', '▤', 'Financial', 'Internal accounts')}${quick('calendar', '📅', 'Calendar', 'Availability')}${quick('bookings', '📊', 'Bookings', 'Search & open')}
    </section>
    <section class="card" style="margin-top:1.25rem"><div class="card-title"><div><h2>Upcoming Bookings</h2><p>Next event dates from the live booking ledger.</p></div><button class="secondary small-button no-print" data-view="bookings">View all</button></div>
      ${d.upcoming.length ? `<div class="list">${d.upcoming.map(bookingRow).join('')}</div>` : empty('No bookings yet. Create the first hall booking to begin.')}
    </section>`;
}

function stat(label, value, sub) { return `<article class="stat"><label>${label}</label><b>${value}</b><small>${sub}</small></article>`; }
function quick(view, icon, title, sub) { return `<button class="quick-action" data-view="${view}"><div class="quick-icon">${icon}</div>${title}<small>${sub}</small></button>`; }
function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }

function bookingsPage() {
  recordView('bookings');
  const query = state.bookingQuery.toLowerCase();
  const records = state.bookings.filter((booking) => `${booking.serialNumber} ${booking.customerName} ${booking.phone} ${booking.eventName}`.toLowerCase().includes(query));
  return `${pageHeader('Bookings', 'Find a hall booking, review its financial position or continue its workflow.', '<button class="primary" data-view="new-booking">＋ New Booking</button>')}
    <section class="card"><div class="search-bar"><label class="screen-reader" for="booking-search">Search bookings</label><input class="search-input" id="booking-search" value="${fieldValue(state.bookingQuery)}" placeholder="Search booking number, customer, event or mobile"></div>
      ${records.length ? `<div class="list">${records.map(bookingRow).join('')}</div>` : empty('No matching bookings found.')}
    </section>`;
}

function bookingRow(booking) {
  const status = booking.status === 'active' ? 'Active' : escapeHtml(booking.status);
  return `<article class="item"><div class="item-row"><div><h3>${escapeHtml(booking.serialNumber)} — ${escapeHtml(booking.eventName)}</h3><div>${escapeHtml(booking.customerName)} <span class="muted">· ${escapeHtml(booking.phone || 'No mobile')}</span></div><p>${escapeHtml(scheduleText(booking))} · Hall rent ${money(booking.hallRent)}</p><div class="chips"><span class="chip">Due ${money(booking.calculated.customerBalanceDue)}</span><span class="chip ${booking.status === 'active' ? '' : 'danger-chip'}">${status}</span></div></div><button class="secondary small-button no-print" data-booking="${booking.id}" data-action="open-booking">Open</button></div></article>`;
}

function newBookingPage() {
  recordView('new-booking');
  return `${pageHeader('New Booking', 'Create the booking before completing customer billing and internal financials.', '<button class="secondary" data-view="bookings">View Bookings</button>')}
    <section class="card"><div class="notice"><b>Create a booking first.</b><br>Customer billing and internal financial records are independently saved after the booking exists. Every save adds a timestamped revision to its history.</div>${bookingForm()}</section>`;
}

function bookingForm(booking = null) {
  const b = booking || { serialNumber: '', eventName: '', customerName: '', phone: '', bookingDate: today(), eventStartLocal: '', eventEndLocal: '', eventTimezone: HALL_TIME_ZONE, hallRent: 0, advances: [{ amount: 0, receivedDate: today(), paymentMode: 'Cash' }, { amount: 0, receivedDate: today(), paymentMode: 'Cash' }], notes: '' };
  const a1 = b.advances?.[0] || {}; const a2 = b.advances?.[1] || {};
  const availability = state.availability;
  return `<form id="booking-form">
    <div class="form-grid">
      ${field('Booking / Serial No.', 'serialNumber', b.serialNumber, 'text', 'SS001', true)}${field('Event Type', 'eventName', b.eventName, 'text', 'Marriage / Reception')}
      ${field('Customer Name', 'customerName', b.customerName, 'text', '', true)}${field('Phone Number', 'phone', b.phone, 'tel', 'Mobile number')}
      ${field('Booking Date', 'bookingDate', b.bookingDate, 'date')}${timeZoneField('Event time zone', 'eventTimezone', b.eventTimezone || HALL_TIME_ZONE)}
      ${field('Event starts', 'eventStartLocal', dateTimeInput(b.eventStartLocal), 'datetime-local', '', true)}${field('Event ends', 'eventEndLocal', dateTimeInput(b.eventEndLocal), 'datetime-local', '', true)}
      ${field('Hall Rent', 'hallRent', b.hallRent, 'number', '', false, 'min="0" step="1"')}${field('1st Advance', 'advance1Amount', a1.amount, 'number', '', false, 'min="0" step="1"')}
      ${field('1st Advance Received Date', 'advance1Date', a1.receivedDate || today(), 'date')}${selectField('1st Advance Payment Mode', 'advance1Mode', a1.paymentMode || 'Cash')}
      ${field('2nd Advance', 'advance2Amount', a2.amount, 'number', '', false, 'min="0" step="1"')}${field('2nd Advance Received Date', 'advance2Date', a2.receivedDate || today(), 'date')}
      ${selectField('2nd Advance Payment Mode', 'advance2Mode', a2.paymentMode || 'Cash')}
    </div>
    <div class="notice info schedule-notice"><b>Availability is checked by exact time, not only by date.</b><br>Use the event’s local clock and IANA time zone. The server converts it to one absolute timeline, rejects overlap in any time zone, and permits only adjacent slots.</div>
    <div class="button-row no-print"><button class="secondary" type="button" data-action="check-availability">⌕ Check Availability</button><span id="availability-result" class="availability-result">${availability ? availabilityMessage(availability) : 'Choose a start, end and time zone to check the hall.'}</span></div>
    <div class="field"><label for="notes">Notes / Remarks</label><textarea id="notes" name="notes" placeholder="Optional booking remarks">${fieldValue(b.notes)}</textarea></div>
    <button class="primary" type="submit">💾 ${booking ? 'Add Booking Revision' : 'Create Booking'}</button>
  </form>`;
}

function field(label, name, value = '', type = 'text', placeholder = '', required = false, attributes = '') {
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label><input id="${name}" name="${name}" type="${type}" value="${fieldValue(value)}" placeholder="${escapeHtml(placeholder)}" ${required ? 'required' : ''} ${attributes}></div>`;
}
function selectField(label, name, value) {
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label><select id="${name}" name="${name}">${['Cash', 'UPI', 'Company Account', 'Bank Transfer'].map((option) => `<option ${option === value ? 'selected' : ''}>${option}</option>`).join('')}</select></div>`;
}
function timeZoneField(label, name, value) {
  const zones = [HALL_TIME_ZONE, 'Asia/Dubai', 'UTC', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label><input id="${name}" name="${name}" list="time-zone-options" value="${fieldValue(value)}" required><datalist id="time-zone-options">${zones.map((zone) => `<option value="${escapeHtml(zone)}">`).join('')}</datalist><small>Any valid IANA time zone is accepted and stored with the booking.</small></div>`;
}
function directionField(label, name, value = 'credit') {
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label><select id="${name}" name="${name}"><option value="credit" ${value === 'credit' ? 'selected' : ''}>Credit</option><option value="debit" ${value === 'debit' ? 'selected' : ''}>Debit</option></select></div>`;
}

function bookingDetailPage() {
  const booking = selectedBooking();
  if (!booking) return missingBooking();
  recordView('booking-detail');
  const c = booking.calculated;
  const active = booking.status === 'active';
  const actionButtons = active
    ? `<button class="primary" data-document="confirmation">💬 Booking Confirmation</button><button class="secondary" data-view="billing">🧾 Customer Billing</button><button class="secondary" data-view="finance">▤ Financial</button><button class="secondary" data-document="bill">Preview Customer Bill</button><button class="secondary" data-document="finance">Preview Financial</button><button class="secondary" data-view="history">◷ Audit History</button><button class="danger-button" data-action="cancel-booking">Archive / Delete Booking</button>`
    : `<button class="primary" data-action="restore-booking">Restore Booking</button><button class="secondary" data-document="confirmation">View Confirmation</button><button class="secondary" data-document="bill">View Customer Bill</button><button class="secondary" data-document="finance">View Financial</button><button class="secondary" data-view="history">◷ Audit History</button>`;
  return `${pageHeader(booking.serialNumber, `${booking.customerName} · ${scheduleText(booking)}`, `<button class="secondary" data-view="bookings">← Bookings</button>${active ? '<button class="primary" data-view="edit-booking">✏️ Revise Booking</button>' : ''}`)}
    <section class="card"><div class="item-row"><div><h2 style="margin:0;color:var(--navy)">${escapeHtml(booking.customerName)}</h2><p class="muted">${escapeHtml(booking.eventName)} · ${escapeHtml(scheduleText(booking))} · ${escapeHtml(booking.phone || 'No phone')}</p></div><span class="badge ${active ? 'green' : 'gold'}">${escapeHtml(booking.status)}</span></div>
      ${active ? '' : '<div class="notice">This booking is archived/deleted from live operations, so dashboard and finance totals exclude it and its time slot is available for a new booking. Its immutable history and actual cash entries remain available; if money was refunded, record an explicit cash debit adjustment. Restore is available only while the original slot has not been taken.</div>'}
      <div class="chips"><span class="chip">Hall Rent ${money(booking.hallRent)}</span><span class="chip">Advance ${money(c.advanceTotal)}</span><span class="chip">Customer Due ${money(c.customerBalanceDue)}</span>${c.customerCredit ? `<span class="chip">Customer Credit ${money(c.customerCredit)}</span>` : ''}<span class="chip">Event Balance ${money(c.eventBalance)}</span></div>
      <hr class="rule"><div class="button-row no-print">${actionButtons}</div>
    </section>
    <section class="split" style="margin-top:1rem"><article class="card">${summaryTable('Customer Billing', [['Hall rent', money(booking.hallRent)], ['Water', money(booking.water)], ['Power', `${booking.powerUnits} × ₹18 = ${money(booking.powerUnits * 18)}`], ['Amount received', money(c.receivedTotal)], [c.customerCredit ? 'Customer credit' : 'Balance due', money(c.customerCredit || c.customerBalanceDue)]])}</article><article class="card">${summaryTable('Internal Finance', [['Financial total', money(c.financialTotal)], ['Expenses', `− ${money(c.expenseTotal)}`], ['Non-cash advances', `− ${money(c.nonCashAdvances)}`], ['Event balance', money(c.eventBalance)]])}</article></section>`;
}

function summaryTable(title, rows) {
  return `<div class="card-title"><h2>${title}</h2></div><table class="summary-table"><tbody>${rows.map(([label, value], index) => `<tr class="${index === rows.length - 1 ? 'total' : ''}"><td>${label}</td><td>${value}</td></tr>`).join('')}</tbody></table>`;
}

function missingBooking() { return `${pageHeader('Booking unavailable', 'Select a booking from the list to continue.')}${empty('This booking no longer exists in the projected ledger.')}`; }

function editBookingPage() {
  const booking = selectedBooking();
  if (!booking) return missingBooking();
  if (booking.status !== 'active') return `${pageHeader(`Archived — ${booking.serialNumber}`, 'Archived bookings are preserved for audit and cannot be revised.')}<section class="card">${empty('Restore the booking from its details if the time slot is still free, or create a new booking for a different slot.')}</section>`;
  recordView('edit-booking');
  return `${pageHeader(`Revise ${booking.serialNumber}`, 'Saving creates a new booking revision; the prior version remains in the audit trail.', '<button class="secondary" data-view="booking">← Booking</button>')}<section class="card"><div class="notice info">This is an additive correction. Earlier booking details remain visible in the booking audit history.</div>${bookingForm(booking)}</section>`;
}

function billingPage() {
  const booking = selectedBooking()?.status === 'active' ? selectedBooking() : state.bookings.find((entry) => entry.status === 'active');
  if (!booking) return `${pageHeader('Customer Billing', 'Choose a booking to create a customer-facing final bill.')}${empty('Create a booking first.')}`;
  state.selectedBookingId = booking.id;
  recordView('billing');
  return `${pageHeader('Customer Billing', `${booking.serialNumber} — ${booking.customerName}`, '<button class="secondary" data-view="booking">← Booking</button><button class="primary" data-document="bill">Preview Bill</button>')}
    <section class="card"><div class="notice"><b>CUSTOMER BILLING — CUSTOMER USE ONLY</b><br>Decoration and lighting commissions are kept out of this document. Other charges remain customer-facing; mark a charge as Finance Income only when it should also be counted in internal finance.</div>
      <form id="billing-form"><div class="form-grid">${field('Water', 'water', booking.water, 'number', '', false, 'min="0" step="1"')}${field('Power Units', 'powerUnits', booking.powerUnits, 'number', '', false, 'min="0" step="1"')}</div>
      <h2 class="section-title">Other Charges</h2><div id="other-charges">${otherChargeRows(booking.otherCharges)}</div><button class="secondary small-button" type="button" data-action="add-other">＋ Add Other Charge</button>
      <h2 class="section-title">Final Payment</h2><div class="form-grid">${field('Final Payment Amount', 'finalPaymentAmount', booking.finalPayment?.amount, 'number', '', false, 'min="0" step="1"')}${selectField('Final Payment Mode', 'finalPaymentMode', booking.finalPayment?.paymentMode || 'Cash')}${field('Final Payment Received Date', 'finalPaymentReceivedDate', booking.finalPayment?.receivedDate || today(), 'date')}</div><label class="field checkbox-label"><input name="finalPaymentCleared" type="checkbox" ${booking.finalPayment?.cleared ? 'checked' : ''}> Payment cleared and received</label>
      <div class="card" id="billing-preview" style="background:#f8fbff;margin:1rem 0">${billingPreview(booking)}</div><button class="primary" type="submit">💾 Add Billing Revision</button></form>
    </section>`;
}

function otherChargeRows(charges = []) {
  if (!charges.length) return otherChargeRow();
  return charges.map(otherChargeRow).join('');
}
function otherChargeRow(charge = {}) {
  return `<div class="repeat-row other-charge-row"><div class="field"><label>Charge name</label><input class="other-name" value="${fieldValue(charge.name)}" placeholder="Charge name"></div><div class="field"><label>Amount</label><input class="other-amount" type="number" min="0" step="1" value="${fieldValue(charge.amount || '')}" placeholder="0"></div><label class="inline-check"><input class="other-finance" type="checkbox" ${charge.financeIncome ? 'checked' : ''}> Finance income</label><button class="remove-row" type="button" data-action="remove-other" aria-label="Remove other charge">×</button></div>`;
}
function billingPreview(booking) {
  const c = booking.calculated;
  return summaryTable('Customer Bill Preview', [['Customer bill total', money(c.customerBillTotal)], ['Amount received', money(c.receivedTotal)], ['Balance due', money(c.customerBalanceDue)]]);
}

function financePage() {
  const booking = selectedBooking()?.status === 'active' ? selectedBooking() : state.bookings.find((entry) => entry.status === 'active');
  if (!booking) return `${pageHeader('Financial', 'Choose a booking to record internal event finance.')}${empty('Create a booking first.')}`;
  state.selectedBookingId = booking.id;
  recordView('finance');
  return `${pageHeader('Financial', `${booking.serialNumber} — ${booking.customerName}`, '<button class="secondary" data-view="booking">← Booking</button><button class="primary" data-document="finance">Preview Financial</button>')}
    <section class="card"><div class="notice"><b>FINANCIAL — INTERNAL ACCOUNT PURPOSES ONLY</b><br>Decoration and lighting vendor totals calculate a 30% commission. Expenses and non-cash advances are factored into Event Balance; final customer payment is not an internal-finance line.</div>
      <form id="finance-form"><div class="form-grid three">${field('Decoration Total (Vendor)', 'decorationVendorTotal', booking.decorationVendorTotal, 'number', '', false, 'min="0" step="1"')}${field('Decoration @30%', 'decorationCommission', booking.decorationCommission, 'number', '', false, 'min="0" step="1"')}${field('Lighting Total (Vendor)', 'lightingVendorTotal', booking.lightingVendorTotal, 'number', '', false, 'min="0" step="1"')}${field('Lighting @30%', 'lightingCommission', booking.lightingCommission, 'number', '', false, 'min="0" step="1"')}${field('Water', 'water', booking.water, 'number', '', false, 'min="0" step="1"')}${field('Power Units', 'powerUnits', booking.powerUnits, 'number', '', false, 'min="0" step="1"')}</div>
      <h2 class="section-title">Expenses</h2><div class="notice info">Every expense is an internal record. Saving adds a new finance revision; it never removes the previous entry history.</div><div id="expenses">${expenseRows(booking.expenses)}</div><button class="secondary small-button" type="button" data-action="add-expense">＋ Add Expense</button><div class="card" id="finance-preview" style="background:#f8fbff;margin:1rem 0">${financePreview(booking)}</div><button class="primary" type="submit">💾 Add Financial Revision</button></form>
    </section>`;
}

function expenseRows(expenses = []) { return expenses.length ? expenses.map(expenseRow).join('') : expenseRow(); }
function expenseRow(expense = {}) { return `<div class="repeat-row expense-row" data-expense-id="${fieldValue(expense.id || '')}"><div class="field"><label>Expense name</label><input class="expense-name" value="${fieldValue(expense.name)}" placeholder="Electrician / Rent / Other"></div><div class="field"><label>Amount</label><input class="expense-amount" type="number" min="0" step="1" value="${fieldValue(expense.amount || '')}" placeholder="0"></div><div class="field"><label>Paid date</label><input class="expense-date" type="date" value="${fieldValue(expense.paidDate || today())}"></div><div class="field"><label>Payment mode</label><select class="expense-mode">${['Cash', 'UPI', 'Company Account', 'Bank Transfer'].map((option) => `<option ${option === (expense.paymentMode || 'Cash') ? 'selected' : ''}>${option}</option>`).join('')}</select></div><button class="remove-row" type="button" data-action="remove-expense" aria-label="Remove expense">×</button></div>`; }
function financePreview(booking) { const c = booking.calculated; return summaryTable('Internal Financial Preview', [['Financial total', money(c.financialTotal)], ['Expenses', `− ${money(c.expenseTotal)}`], ['UPI / Company Account advances', `− ${money(c.nonCashAdvances)}`], ['Event balance', money(c.eventBalance)]]); }

function calendarPage() {
  recordView('calendar');
  const cursor = state.calendarMonth;
  const year = cursor.getUTCFullYear(); const month = cursor.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1)); const start = new Date(Date.UTC(year, month, 1 - first.getUTCDay()));
  const map = state.bookings.filter((booking) => booking.status === 'active').reduce((groups, booking) => {
    occupiedDateKeys(booking).forEach((date) => (groups[date] ||= []).push(booking));
    return groups;
  }, {});
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start); day.setUTCDate(start.getUTCDate() + index);
    const key = day.toISOString().slice(0, 10); const list = map[key] || []; const current = day.getUTCMonth() === month;
    return `<button class="calendar-day ${current ? '' : 'muted-day'} ${key === today() ? 'today' : ''} ${list.length ? 'booked' : ''}" data-action="calendar-day" data-date="${key}"><b>${day.getUTCDate()}</b>${list.length ? `<small>● ${list.length} booking${list.length > 1 ? 's' : ''}</small>` : ''}</button>`;
  }).join('');
  return `${pageHeader('Calendar / Availability', 'Active bookings are shown on each date they occupy. Exact time conflict checks are available when you create or revise a booking.')}
    <section class="card"><div class="notice info"><b>Calendar dates use ${HALL_LOCATION} time (IST) and are an occupancy overview, not a date-only lock.</b><br>Two events on the same date can be recorded only when their exact intervals do not overlap after time-zone conversion.</div><div class="calendar-toolbar"><h2>${new Intl.DateTimeFormat('en-IN', { timeZone: HALL_TIME_ZONE, month: 'long', year: 'numeric' }).format(cursor)}</h2><div class="calendar-nav no-print"><button class="secondary small-button" data-action="calendar-prev">‹</button><button class="secondary small-button" data-action="calendar-today">Today</button><button class="secondary small-button" data-action="calendar-next">›</button></div></div><div class="calendar-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<div class="calendar-day-name">${day}</div>`).join('')}${cells}</div><div class="chips" style="margin-top:1rem"><span class="chip">🔵 Occupied date</span><span class="chip">⬜ No active booking</span><span class="chip">Select a date for schedule details</span></div></section><section id="calendar-detail" class="card" style="margin-top:1rem">${empty('Select a date to review active schedules.')}</section>`;
}

function customersPage() {
  recordView('customers');
  const query = state.customerQuery.toLowerCase();
  const customers = state.bookings.filter((booking) => `${booking.customerName} ${booking.phone} ${booking.serialNumber}`.toLowerCase().includes(query));
  return `${pageHeader('Customers', 'Customers are automatically derived from your booking records.')}
    <section class="card"><div class="search-bar"><label class="screen-reader" for="customer-search">Search customers</label><input class="search-input" id="customer-search" value="${fieldValue(state.customerQuery)}" placeholder="Search name, mobile or booking number"></div>${customers.length ? `<div class="list">${customers.map((booking) => `<article class="item"><div class="item-row"><div><h3>${escapeHtml(booking.customerName)}</h3><p>${escapeHtml(booking.phone || 'No mobile')} · ${escapeHtml(booking.serialNumber)}</p></div><div class="button-row no-print"><button class="secondary small-button" data-action="call" data-phone="${escapeHtml(booking.phone)}">📞 Call</button><button class="secondary small-button" data-action="whatsapp" data-phone="${escapeHtml(booking.phone)}">💬 WhatsApp</button><button class="secondary small-button" data-booking="${booking.id}" data-action="open-booking">Open</button></div></div></article>`).join('')}</div>` : empty('No customers match this search.')}</section>`;
}

function cashPage() {
  recordView('cash');
  const balance = state.cash.length ? state.cash[state.cash.length - 1].runningBalance : 0;
  const credit = state.cash.filter((entry) => entry.direction === 'credit').reduce((sum, entry) => sum + entry.amount, 0);
  const debit = state.cash.filter((entry) => entry.direction === 'debit').reduce((sum, entry) => sum + entry.amount, 0);
  const startOfMonth = `${today().slice(0, 7)}-01`;
  return `${pageHeader('Cash Balance', 'An append-only cash ledger fed by cash booking receipts, cash expenses and manual external entries.', '<button class="secondary" data-action="show-adjustment">± Add Adjustment</button>')}
    <section class="card"><div class="notice"><b>Integrated cash ledger</b><br>Cash advances, cleared cash final payments and cash-mode event expenses are added automatically when their booking revision is saved. Record manual entries here only for cash outside a booking. To correct a manual entry, add a balancing adjustment; existing history is never changed or deleted.</div><form id="cash-form"><div class="form-grid three">${field('Date', 'date', today(), 'date')}${directionField('Direction', 'direction', 'credit')}${field('External reference', 'reference', '', 'text', 'CASH001 / supplier receipt')}${field('Details', 'details', '', 'text', 'Petty cash / other')}${field('Amount', 'amount', '', 'number', '0', true, 'min="1" step="1"')}</div><button class="primary" type="submit">＋ Add Manual Cash Entry</button></form><div id="adjustment-area"></div></section>
    <section class="stat-grid"><article class="stat"><label>Total Credit</label><b>${money(credit)}</b><small>All append-only credits</small></article><article class="stat"><label>Total Debit</label><b>${money(debit)}</b><small>All append-only debits</small></article><article class="stat"><label>Cash Balance</label><b>${money(balance)}</b><small>Running ledger balance</small></article><article class="stat"><label>Entries</label><b>${state.cash.length}</b><small>Including corrections</small></article></section>
    <section class="card"><div class="card-title"><div><h2>Cash Balance Report</h2><p>Select a date range to produce a print-ready report.</p></div></div><form id="cash-report-form"><div class="form-grid"><div class="field"><label for="report-from">From Date</label><input id="report-from" name="from" type="date" value="${startOfMonth}"></div><div class="field"><label for="report-to">To Date</label><input id="report-to" name="to" type="date" value="${today()}"></div></div><button class="secondary" type="submit">📊 View Custom Report</button></form><div id="cash-report-result"></div></section>
    <section class="card"><div class="card-title"><div><h2>Transaction History</h2><p>Every entry remains in this ledger. No deletion or overwriting is available.</p></div></div>${cashTable(state.cash.slice().reverse())}</section>`;
}

function cashTable(entries) {
  return entries.length ? `<div class="table-scroll"><table class="report-table"><thead><tr><th>Date</th><th>ID / Details</th><th>Type</th><th>Credit</th><th>Debit</th><th>Balance</th></tr></thead><tbody>${entries.map((entry) => { const automatic = entry.eventType === 'cash.automatic.recorded'; const type = automatic ? 'Booking / Finance' : entry.eventType === 'cash.adjustment.recorded' ? 'Adjustment' : 'Manual'; return `<tr><td>${shortDate(entry.date)}</td><td>${escapeHtml(entry.reference || entry.details || '—')}${entry.correctionFor ? `<br><small class="muted">Correction for ${escapeHtml(entry.correctionFor)}</small>` : ''}${automatic ? '<br><small class="muted">Generated from an approved booking revision</small>' : ''}</td><td><span class="badge ${automatic ? 'green' : entry.eventType === 'cash.adjustment.recorded' ? 'gold' : ''}">${type}</span></td><td>${entry.direction === 'credit' ? money(entry.amount) : '—'}</td><td>${entry.direction === 'debit' ? money(entry.amount) : '—'}</td><td>${money(entry.runningBalance)}</td></tr>`; }).join('')}</tbody></table></div>` : empty('No cash entries yet. Add the first credit or debit above.');
}

function backupPage() {
  recordView('backup');
  return `${pageHeader('Backup & Audit', 'Owner-only backups and the immutable operational history.', '<button class="primary" data-action="export-backup">⬇ Export Backup</button>')}
    <section class="split"><article class="card"><div class="card-title"><div><h2>Data Protection</h2><p>Backups contain the immutable event history and can only add unseen events when imported.</p></div></div><div class="notice info">Import never replaces the current database. Existing event IDs are ignored, and imported events are appended to the local ledger.</div><div class="button-row no-print"><button class="primary" data-action="export-backup">⬇ Download Backup</button><label class="secondary" style="display:inline-flex;align-items:center">⬆ Import Backup<input id="import-backup" type="file" accept="application/json,.json" class="screen-reader"></label></div></article><article class="card"><div class="card-title"><div><h2>Scheduled Local Backup</h2><p>Daily owner-managed server-side JSON backup in ${HALL_TIME_ZONE}.</p></div></div><form id="backup-schedule-form"><label class="field checkbox-label"><input type="checkbox" name="enabled" ${state.backupSchedule.enabled ? 'checked' : ''}> Enable daily local backup</label><div class="field"><label for="backup-time">Backup Time (IST)</label><input id="backup-time" name="time" type="time" value="${fieldValue(state.backupSchedule.time || '23:00')}"></div><button class="secondary" type="submit">💾 Save Schedule</button></form></article></section>
    <section class="card"><div class="card-title"><div><h2>Operational Audit Trail</h2><p>Newest actions first. These are immutable event records.</p></div></div><div class="timeline">${state.activity.length ? state.activity.map((event) => `<article class="timeline-item"><span class="timeline-dot"></span><div><b>${escapeHtml(event.summary)}</b> <small>by ${escapeHtml(event.actorName)}</small><p>${datetime(event.occurredAt)} · ${escapeHtml(event.aggregateType)} / ${escapeHtml(event.aggregateId)}</p></div></article>`).join('') : empty('No events yet.')}</div></section>`;
}

function documentPage() {
  const booking = selectedBooking();
  if (!booking) return missingBooking();
  const kind = state.selectedDocument || 'confirmation';
  recordView(`${kind}-document`);
  const titles = { confirmation: 'Booking Confirmation', bill: 'Customer Bill', finance: 'Financial Report' };
  return `${pageHeader(titles[kind], `${booking.serialNumber} — a branded, print-ready document.`, `<button class="secondary" data-view="booking">← Booking</button><button class="secondary" data-action="share-document">↗ Share</button><button class="primary" data-action="print-document">🖨 Print / Save PDF</button>`)}<section class="document-wrap">${documentPaper(kind, booking)}</section>`;
}

function documentPaper(kind, booking) {
  const c = booking.calculated;
  const head = (subtitle) => `<div class="document-paper"><div class="document-topline"></div><div class="document-brand">SRI SQUARE CONVENTION</div><div class="document-sub">${subtitle} · ${HALL_LOCATION}</div>`;
  const details = `<section class="document-section"><h3>BOOKING DETAILS</h3><table class="report-table"><tbody><tr><td>Booking</td><td>${escapeHtml(booking.serialNumber)}</td></tr><tr><td>Customer</td><td>${escapeHtml(booking.customerName)}</td></tr><tr><td>Mobile</td><td>${escapeHtml(booking.phone || '—')}</td></tr><tr><td>Event / Schedule</td><td>${escapeHtml(booking.eventName)} · ${escapeHtml(scheduleText(booking))}</td></tr><tr><td>Status</td><td>${escapeHtml(booking.status)}</td></tr></tbody></table></section>`;
  if (kind === 'confirmation') return `${head('BOOKING CONFIRMATION')}${details}<section class="document-section"><h3>PAYMENT DETAILS</h3><table class="report-table"><tbody><tr><td>Hall Rent</td><td>${money(booking.hallRent)}</td></tr><tr><td>1st Advance</td><td>${money(booking.advances[0]?.amount)} (${escapeHtml(booking.advances[0]?.paymentMode || 'Cash')})</td></tr><tr><td>2nd Advance</td><td>${money(booking.advances[1]?.amount)} (${escapeHtml(booking.advances[1]?.paymentMode || 'Cash')})</td></tr><tr class="total"><td>Total Advance Paid</td><td>${money(c.advanceTotal)}</td></tr><tr><td>Balance Pending</td><td>${money(Math.max(0, booking.hallRent - c.advanceTotal))}</td></tr></tbody></table></section>${booking.notes ? `<section class="document-section"><h3>REMARKS</h3><p>${escapeHtml(booking.notes)}</p></section>` : ''}<section class="document-section"><h3>TERMS & CONDITIONS</h3><ol class="terms">${terms.map((term) => `<li>${escapeHtml(term)}</li>`).join('')}</ol></section><p class="document-note"><b>Thank you for choosing SRI SQUARE CONVENTION.</b><br>Contact: 8801234288 / 9121013113</p></div>`;
  if (kind === 'bill') return `${head('CUSTOMER BILL')}${details}<section class="document-section"><h3>CHARGES</h3><table class="report-table"><tbody><tr><td>Hall Rent</td><td>${money(booking.hallRent)}</td></tr><tr><td>Water</td><td>${money(booking.water)}</td></tr><tr><td>Power</td><td>${booking.powerUnits} × ₹18 = ${money(booking.powerUnits * 18)}</td></tr>${booking.otherCharges.map((charge) => `<tr><td>${escapeHtml(charge.name)}</td><td>${money(charge.amount)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td>${money(c.customerBillTotal)}</td></tr><tr><td>Amount Received</td><td>${money(c.receivedTotal)}</td></tr><tr><td>Balance Due</td><td>${money(c.customerBalanceDue)}</td></tr></tbody></table></section><p class="document-note">GST, if applicable, will be charged extra.</p></div>`;
  return `${head('FINANCIAL — INTERNAL')}${details}<section class="document-section"><h3>INCOME / REVENUE</h3><table class="report-table"><tbody><tr><td>Hall Rent</td><td>${money(booking.hallRent)}</td></tr><tr><td>Water</td><td>${money(booking.water)}</td></tr><tr><td>Power</td><td>${booking.powerUnits} × ₹18 = ${money(booking.powerUnits * 18)}</td></tr><tr><td>Decoration @30%</td><td>${money(booking.decorationCommission)}</td></tr><tr><td>Lighting @30%</td><td>${money(booking.lightingCommission)}</td></tr>${booking.otherCharges.filter((charge) => charge.financeIncome).map((charge) => `<tr><td>${escapeHtml(charge.name)}</td><td>${money(charge.amount)}</td></tr>`).join('')}<tr class="total"><td>Financial Total</td><td>${money(c.financialTotal)}</td></tr></tbody></table></section><section class="document-section"><h3>EXPENSES</h3><table class="report-table"><tbody>${booking.expenses.length ? booking.expenses.map((expense) => `<tr><td>${escapeHtml(expense.name)}</td><td>− ${money(expense.amount)}</td></tr>`).join('') : '<tr><td>No expenses entered</td><td>₹0</td></tr>'}<tr><td>UPI / Company Account Advances</td><td>− ${money(c.nonCashAdvances)}</td></tr><tr class="total"><td>Event Balance</td><td>${money(c.eventBalance)}</td></tr></tbody></table></section><p class="document-note">Internal accounts only. Customer Billing is separate.</p></div>`;
}

function historyPage() {
  const booking = selectedBooking();
  if (!booking) return missingBooking();
  recordView('booking-history');
  return `${pageHeader(`Audit History — ${booking.serialNumber}`, 'Every revision of this booking is preserved as a separate event.', '<button class="secondary" data-view="booking">← Booking</button>')}<section class="card"><div class="timeline">${state.bookingEvents.length ? state.bookingEvents.slice().reverse().map((event) => `<article class="timeline-item"><span class="timeline-dot"></span><div><b>${escapeHtml(eventSummary(event.eventType))}</b><small> by ${escapeHtml(event.actorName)}</small><p>${datetime(event.occurredAt)} · ${escapeHtml(describeEvent(event))}</p></div></article>`).join('') : empty('Loading booking history…')}</div></section>`;
}

function eventSummary(type) { return ({ 'booking.created': 'Created booking', 'booking.revised': 'Revised booking details', 'booking.cancelled': 'Archived / deleted booking', 'booking.reinstated': 'Restored booking', 'billing.revised': 'Saved customer billing', 'finance.revised': 'Saved internal financials', 'cash.automatic.recorded': 'Recorded automatic cash movement', 'availability.checked': 'Checked availability' }[type] || type.replaceAll('.', ' ')); }
function describeEvent(event) { const keys = Object.keys(event.payload || {}); return keys.length ? `Changed: ${keys.join(', ')}` : 'No additional fields'; }

function pages() { return { home: homePage, bookings: bookingsPage, 'new-booking': newBookingPage, booking: bookingDetailPage, 'edit-booking': editBookingPage, billing: billingPage, finance: financePage, calendar: calendarPage, customers: customersPage, cash: cashPage, backup: backupPage, document: documentPage, history: historyPage }; }

function bindShell() {
  app.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  app.querySelectorAll('[data-action="toggle-menu"]').forEach((button) => button.addEventListener('click', () => { state.menuOpen = !state.menuOpen; render(); }));
  app.querySelectorAll('[data-action="close-menu"]').forEach((button) => button.addEventListener('click', () => { state.menuOpen = false; render(); }));
  app.querySelectorAll('[data-action="open-booking"]').forEach((button) => button.addEventListener('click', () => openBooking(button.dataset.booking)));
  app.querySelectorAll('[data-document]').forEach((button) => button.addEventListener('click', () => { state.selectedDocument = button.dataset.document; navigate('document'); }));
  app.querySelectorAll('[data-action="print-document"]').forEach((button) => button.addEventListener('click', () => window.print()));
  app.querySelectorAll('[data-action="share-document"]').forEach((button) => button.addEventListener('click', shareDocument));
  app.querySelectorAll('[data-action="call"]').forEach((button) => button.addEventListener('click', () => contact('tel', button.dataset.phone)));
  app.querySelectorAll('[data-action="whatsapp"]').forEach((button) => button.addEventListener('click', () => contact('whatsapp', button.dataset.phone)));
  app.querySelectorAll('[data-action="cancel-booking"]').forEach((button) => button.addEventListener('click', cancelBooking));
  app.querySelectorAll('[data-action="restore-booking"]').forEach((button) => button.addEventListener('click', restoreBooking));
}

function bindView() {
  if (state.view === 'new-booking' || state.view === 'edit-booking') bindBookingForm();
  if (state.view === 'bookings') document.getElementById('booking-search')?.addEventListener('input', (event) => { state.bookingQuery = event.target.value; render(); });
  if (state.view === 'customers') document.getElementById('customer-search')?.addEventListener('input', (event) => { state.customerQuery = event.target.value; render(); });
  if (state.view === 'billing') bindBilling();
  if (state.view === 'finance') bindFinance();
  if (state.view === 'calendar') bindCalendar();
  if (state.view === 'cash') bindCash();
  if (state.view === 'backup') bindBackup();
}

function navigate(view) {
  if (view === 'new-booking' || view === 'edit-booking') state.availability = null;
  state.view = view;
  state.menuOpen = false;
  render();
  if (view === 'history' && state.selectedBookingId) {
    api(`/api/bookings/${state.selectedBookingId}/events`).then((data) => {
      state.bookingEvents = data.events;
      if (state.view === 'history') render();
    }).catch((error) => toast(error.message, 'error'));
  }
}

async function openBooking(bookingId) {
  state.selectedBookingId = bookingId;
  state.bookingEvents = [];
  navigate('booking');
}

function bookingPayload(form) {
  const data = new FormData(form);
  return {
    serialNumber: data.get('serialNumber'), eventName: data.get('eventName'), customerName: data.get('customerName'), phone: data.get('phone'), bookingDate: data.get('bookingDate'), eventStartLocal: data.get('eventStartLocal'), eventEndLocal: data.get('eventEndLocal'), eventTimezone: data.get('eventTimezone'), hallRent: data.get('hallRent'), notes: data.get('notes'),
    advances: [{ amount: data.get('advance1Amount'), receivedDate: data.get('advance1Date'), paymentMode: data.get('advance1Mode') }, { amount: data.get('advance2Amount'), receivedDate: data.get('advance2Date'), paymentMode: data.get('advance2Mode') }]
  };
}

function bindBookingForm() {
  document.querySelector('[data-action="check-availability"]')?.addEventListener('click', checkAvailability);
  document.getElementById('booking-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = bookingPayload(event.currentTarget);
      if (state.view === 'new-booking') {
        const data = await api('/api/bookings', { method: 'POST', body: payload });
        await refresh(); state.selectedBookingId = data.booking.id; state.view = 'booking'; toast('Booking created. Customer billing and finance can now be recorded.');
      } else {
        await api(`/api/bookings/${state.selectedBookingId}/revisions`, { method: 'POST', body: payload });
        await refresh(); state.view = 'booking'; toast('Booking revision added to the audit history.');
      }
      render();
    } catch (error) { showBookingError(error); }
  });
}

function conflictList(conflicts = []) {
  return conflicts.map((booking) => `${booking.serialNumber} (${scheduleText(booking)})`).join('; ');
}
function availabilityMessage(result) {
  if (result.available) return `<span class="availability-okay">✓ Available: ${escapeHtml(scheduleText(result.schedule))}</span>`;
  return `<span class="availability-conflict">Unavailable — overlaps ${escapeHtml(conflictList(result.conflicts))}</span>`;
}
async function checkAvailability() {
  const form = document.getElementById('booking-form'); if (!form) return;
  const payload = bookingPayload(form);
  if (!payload.eventStartLocal || !payload.eventEndLocal) return toast('Enter an event start and end time before checking availability.', 'error');
  try {
    const query = { eventStartLocal: payload.eventStartLocal, eventEndLocal: payload.eventEndLocal, eventTimezone: payload.eventTimezone };
    if (state.view === 'edit-booking' && state.selectedBookingId) query.excludeBookingId = state.selectedBookingId;
    state.availability = await api('/api/availability/check', { method: 'POST', body: query });
    const target = document.getElementById('availability-result'); if (target) target.innerHTML = availabilityMessage(state.availability);
    toast(state.availability.available ? 'This exact time slot is available.' : `Time conflict: ${conflictList(state.availability.conflicts)}`, state.availability.available ? 'success' : 'error');
  } catch (error) { toast(error.message, 'error'); }
}
function showBookingError(error) {
  const conflicts = error.details?.conflicts || [];
  if (conflicts.length) return toast(`This time overlaps ${conflictList(conflicts)}. Change the schedule and try again.`, 'error');
  toast(error.message, 'error');
}

async function cancelBooking() {
  const booking = selectedBooking(); if (!booking) return;
  const reason = window.prompt(`Archive/delete ${booking.serialNumber} from live operations? This keeps its audit and financial history but releases the time slot. Enter a reason (at least 3 characters):`);
  if (reason === null) return;
  if (reason.trim().length < 3) return toast('Enter a cancellation reason of at least 3 characters.', 'error');
  try {
    await api(`/api/bookings/${booking.id}/cancellations`, { method: 'POST', body: { reason } });
    await refresh(); toast('Booking archived. Its time slot is now available; history and financial corrections remain intact.'); render();
  } catch (error) { toast(error.message, 'error'); }
}

async function restoreBooking() {
  const booking = selectedBooking(); if (!booking) return;
  if (!window.confirm(`Restore ${booking.serialNumber} to live operations? The system will first confirm that its original time slot is still available.`)) return;
  try {
    await api(`/api/bookings/${booking.id}/reinstatements`, { method: 'POST', body: {} });
    await refresh(); toast('Booking restored and returned to active operations.'); render();
  } catch (error) { showBookingError(error); }
}

function readOtherCharges() {
  return [...document.querySelectorAll('.other-charge-row')].map((row) => ({ name: row.querySelector('.other-name').value, amount: row.querySelector('.other-amount').value, financeIncome: row.querySelector('.other-finance').checked })).filter((charge) => charge.name || Number(charge.amount));
}

function billingLiveBooking() {
  const booking = selectedBooking(); if (!booking) return null;
  return { ...booking, water: Number(document.getElementById('water')?.value || 0), powerUnits: Number(document.getElementById('powerUnits')?.value || 0), otherCharges: readOtherCharges(), finalPayment: { amount: Number(document.getElementById('finalPaymentAmount')?.value || 0), paymentMode: document.getElementById('finalPaymentMode')?.value || 'Cash', receivedDate: document.getElementById('finalPaymentReceivedDate')?.value || '', cleared: document.querySelector('[name="finalPaymentCleared"]')?.checked || false } };
}

function clientCalculated(booking) {
  const advanceTotal = booking.advances.reduce((sum, advance) => sum + Number(advance.amount || 0), 0);
  const customerBillTotal = Number(booking.hallRent || 0) + Number(booking.water || 0) + Number(booking.powerUnits || 0) * 18 + booking.otherCharges.reduce((sum, charge) => sum + Number(charge.amount || 0), 0);
  const receivedTotal = advanceTotal + (booking.finalPayment.cleared ? Number(booking.finalPayment.amount || 0) : 0);
  return { customerBillTotal, receivedTotal, customerBalanceDue: Math.max(0, customerBillTotal - receivedTotal) };
}

function bindBilling() {
  const form = document.getElementById('billing-form');
  document.querySelector('[data-action="add-other"]')?.addEventListener('click', () => { document.getElementById('other-charges').insertAdjacentHTML('beforeend', otherChargeRow()); bindBillingLive(); });
  document.getElementById('other-charges')?.addEventListener('click', (event) => { if (event.target.closest('[data-action="remove-other"]')) { event.target.closest('.other-charge-row').remove(); updateBillingPreview(); } });
  bindBillingLive();
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const b = billingLiveBooking();
      await api(`/api/bookings/${b.id}/billing`, { method: 'POST', body: { water: b.water, powerUnits: b.powerUnits, otherCharges: b.otherCharges, finalPayment: b.finalPayment } });
      await refresh(); state.view = 'booking'; toast('Customer billing revision added.'); render();
    } catch (error) { toast(error.message, 'error'); }
  });
}
function bindBillingLive() { document.getElementById('billing-form')?.addEventListener('input', updateBillingPreview); document.getElementById('billing-form')?.addEventListener('change', updateBillingPreview); }
function updateBillingPreview() { const booking = billingLiveBooking(); if (!booking) return; const c = clientCalculated(booking); document.getElementById('billing-preview').innerHTML = summaryTable('Customer Bill Preview', [['Customer bill total', money(c.customerBillTotal)], ['Amount received', money(c.receivedTotal)], ['Balance due', money(c.customerBalanceDue)]]); }

function readExpenses() { return [...document.querySelectorAll('.expense-row')].map((row) => ({ id: row.dataset.expenseId || undefined, name: row.querySelector('.expense-name').value, amount: row.querySelector('.expense-amount').value, paidDate: row.querySelector('.expense-date').value, paymentMode: row.querySelector('.expense-mode').value })).filter((expense) => expense.name || Number(expense.amount)); }
function financeLiveBooking() {
  const booking = selectedBooking(); if (!booking) return null;
  const val = (id) => Number(document.getElementById(id)?.value || 0);
  return { ...booking, water: val('water'), powerUnits: val('powerUnits'), decorationVendorTotal: val('decorationVendorTotal'), decorationCommission: val('decorationCommission'), lightingVendorTotal: val('lightingVendorTotal'), lightingCommission: val('lightingCommission'), expenses: readExpenses() };
}
function clientFinance(booking) {
  const financeIncome = booking.otherCharges.filter((charge) => charge.financeIncome).reduce((sum, charge) => sum + Number(charge.amount || 0), 0);
  const financialTotal = Number(booking.hallRent) + Number(booking.water) + Number(booking.powerUnits) * 18 + Number(booking.decorationCommission) + Number(booking.lightingCommission) + financeIncome;
  const expenseTotal = booking.expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const nonCashAdvances = booking.advances.filter((advance) => advance.paymentMode !== 'Cash').reduce((sum, advance) => sum + Number(advance.amount || 0), 0);
  return { financialTotal, expenseTotal, nonCashAdvances, eventBalance: financialTotal - expenseTotal - nonCashAdvances };
}
function bindFinance() {
  const form = document.getElementById('finance-form');
  document.querySelector('[data-action="add-expense"]')?.addEventListener('click', () => { document.getElementById('expenses').insertAdjacentHTML('beforeend', expenseRow()); bindFinanceLive(); });
  document.getElementById('expenses')?.addEventListener('click', (event) => { if (event.target.closest('[data-action="remove-expense"]')) { event.target.closest('.expense-row').remove(); updateFinancePreview(); } });
  document.getElementById('decorationVendorTotal')?.addEventListener('input', (event) => { document.getElementById('decorationCommission').value = Math.round(Number(event.target.value || 0) * .3); updateFinancePreview(); });
  document.getElementById('lightingVendorTotal')?.addEventListener('input', (event) => { document.getElementById('lightingCommission').value = Math.round(Number(event.target.value || 0) * .3); updateFinancePreview(); });
  bindFinanceLive();
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const b = financeLiveBooking();
      await api(`/api/bookings/${b.id}/finance`, { method: 'POST', body: { water: b.water, powerUnits: b.powerUnits, decorationVendorTotal: b.decorationVendorTotal, decorationCommission: b.decorationCommission, lightingVendorTotal: b.lightingVendorTotal, lightingCommission: b.lightingCommission, expenses: b.expenses } });
      await refresh(); state.view = 'booking'; toast('Internal finance revision added.'); render();
    } catch (error) { toast(error.message, 'error'); }
  });
}
function bindFinanceLive() { document.getElementById('finance-form')?.addEventListener('input', updateFinancePreview); }
function updateFinancePreview() { const booking = financeLiveBooking(); if (!booking) return; const c = clientFinance(booking); document.getElementById('finance-preview').innerHTML = summaryTable('Internal Financial Preview', [['Financial total', money(c.financialTotal)], ['Expenses', `− ${money(c.expenseTotal)}`], ['UPI / Company Account advances', `− ${money(c.nonCashAdvances)}`], ['Event balance', money(c.eventBalance)]]); }

function bindCalendar() {
  document.querySelector('[data-action="calendar-prev"]')?.addEventListener('click', () => { state.calendarMonth = new Date(Date.UTC(state.calendarMonth.getUTCFullYear(), state.calendarMonth.getUTCMonth() - 1, 1)); render(); });
  document.querySelector('[data-action="calendar-next"]')?.addEventListener('click', () => { state.calendarMonth = new Date(Date.UTC(state.calendarMonth.getUTCFullYear(), state.calendarMonth.getUTCMonth() + 1, 1)); render(); });
  document.querySelector('[data-action="calendar-today"]')?.addEventListener('click', () => { state.calendarMonth = calendarMonthInHallTimeZone(); render(); });
  document.querySelectorAll('[data-action="calendar-day"]').forEach((button) => button.addEventListener('click', () => {
    const rows = state.bookings.filter((booking) => booking.status === 'active' && occupiedDateKeys(booking).includes(button.dataset.date));
    document.getElementById('calendar-detail').innerHTML = rows.length ? `<div class="card-title"><div><h2>Active schedules on ${shortDate(button.dataset.date)}</h2><p>${rows.length} booking${rows.length > 1 ? 's' : ''} occupies some part of this date.</p></div></div><div class="list">${rows.map(bookingRow).join('')}</div><div class="notice info">A day can show more than one booking when their exact intervals do not overlap.</div>` : `<div class="card-title"><div><h2>${shortDate(button.dataset.date)}</h2><p>This date currently has no active booking.</p></div></div><div class="notice info">Available according to the current local booking ledger. Confirm exact start/end time and time zone in New Booking before committing a reservation.</div>`;
    document.querySelectorAll('#calendar-detail [data-action="open-booking"]').forEach((open) => open.addEventListener('click', () => openBooking(open.dataset.booking)));
  }));
}

function bindCash() {
  document.getElementById('cash-form')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await api('/api/cash', { method: 'POST', body: Object.fromEntries(form) }); await refresh(); toast('Cash entry recorded in the append-only ledger.'); render(); } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelector('[data-action="show-adjustment"]')?.addEventListener('click', showAdjustmentForm);
  document.getElementById('cash-report-form')?.addEventListener('submit', showCashReport);
}

function showAdjustmentForm() {
  const target = document.getElementById('adjustment-area');
  target.innerHTML = `<hr class="rule"><div class="notice info"><b>Add a correction, do not edit history.</b><br>Use a compensating credit or debit for the original entry.</div><form id="adjustment-form"><div class="form-grid three">${field('Date', 'date', today(), 'date')}${field('Original Entry ID', 'correctionFor', '', 'text', 'Paste a cash entry ID', true)}${directionField('Direction', 'direction', 'credit')}${field('Reference', 'reference', '', 'text', 'Correction reference')}${field('Expense Details', 'details', '', 'text', 'Reason for debit')}${field('Amount', 'amount', '', 'number', '0', true, 'min="1" step="1"')}</div><button class="secondary" type="submit">＋ Record Adjustment</button></form><p class="muted" style="font-size:.8rem">Available entry IDs: ${state.cash.map((entry) => escapeHtml(entry.entryId)).join(', ') || 'none yet'}.</p>`;
  document.getElementById('adjustment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api('/api/cash/adjustments', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) }); await refresh(); toast('Cash adjustment recorded; prior entry remains intact.'); render(); } catch (error) { toast(error.message, 'error'); }
  });
}

async function showCashReport(event) {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  try {
    const report = await api(`/api/reports/cash?from=${encodeURIComponent(form.get('from'))}&to=${encodeURIComponent(form.get('to'))}`);
    document.getElementById('cash-report-result').innerHTML = `<div class="card" style="margin-top:1rem;background:#f8fbff"><div class="card-title"><div><h2>Custom Cash Balance Report</h2><p>${shortDate(report.from)} to ${shortDate(report.to)}</p></div><button class="secondary small-button no-print" data-action="print-cash-report">🖨 Print</button></div>${summaryTable('', [['Opening balance', money(report.openingBalance)], ['Total credit', money(report.creditTotal)], ['Total debit', `− ${money(report.debitTotal)}`], ['Closing balance', money(report.closingBalance)]])}${cashTable(report.entries)}</div>`;
    document.querySelector('[data-action="print-cash-report"]')?.addEventListener('click', () => window.print());
  } catch (error) { toast(error.message, 'error'); }
}

function bindBackup() {
  document.querySelectorAll('[data-action="export-backup"]').forEach((button) => button.addEventListener('click', exportBackup));
  document.getElementById('import-backup')?.addEventListener('change', importBackup);
  document.getElementById('backup-schedule-form')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await api('/api/backup/schedule', { method: 'POST', body: { enabled: form.get('enabled') === 'on', time: form.get('time') } }); toast('Scheduled local backup setting saved.'); await refresh(); render(); } catch (error) { toast(error.message, 'error'); }
  });
}

async function exportBackup() {
  try {
    const response = await fetch('/api/backup/export', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Backup export failed.'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `sri-square-backup-${today()}.json`; anchor.click(); URL.revokeObjectURL(url);
    await refresh(); toast('Append-only event backup downloaded.');
  } catch (error) { toast(error.message, 'error'); }
}

async function importBackup(event) {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm(`Import ${data.events?.length || 0} event records? Existing records will remain and only unseen events will be appended.`)) return;
    const result = await api('/api/backup/import', { method: 'POST', body: data });
    await refresh(); toast(`Backup import complete: ${result.added} new event record(s) appended.`); render();
  } catch (error) { toast(error.message || 'This backup could not be imported.', 'error'); }
}

async function shareDocument() {
  const booking = selectedBooking(); const kind = state.selectedDocument || 'confirmation'; if (!booking) return;
  const title = `Sri Square ${kind === 'confirmation' ? 'Booking Confirmation' : kind === 'bill' ? 'Customer Bill' : 'Financial Report'} — ${booking.serialNumber}`;
  const text = `${title}\nCustomer: ${booking.customerName}\nEvent: ${booking.eventName} · ${scheduleText(booking)}\n${kind === 'finance' ? `Event Balance: ${money(booking.calculated.eventBalance)}` : `Balance Due: ${money(booking.calculated.customerBalanceDue)}`}`;
  try { if (navigator.share) await navigator.share({ title, text }); else { await navigator.clipboard.writeText(text); toast('Document summary copied to clipboard.'); } } catch (_) { /* the user may cancel the platform share sheet */ }
}

function contact(kind, phone) {
  const safe = String(phone || '').replace(/\D/g, '');
  if (!safe) return toast('No mobile number is recorded for this customer.', 'error');
  api('/api/actions', { method: 'POST', body: { type: 'report.viewed', screen: `${kind}-contact` } }).catch(() => {});
  window.location.href = kind === 'tel' ? `tel:${safe}` : `https://wa.me/91${safe}`;
}

boot();
