const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-square-test-'));
const port = 39123;
const base = `http://127.0.0.1:${port}`;
let server;

function gunturToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status}: ${body?.error || response.statusText}`);
  return { response, body };
}

async function requestFailure(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
}

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(tempDir, 'operations.db') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start.')), 8000);
    server.stdout.on('data', (data) => {
      if (String(data).includes('running at')) { clearTimeout(timeout); resolve(); }
    });
    server.on('error', reject);
  });
});

after(() => {
  server?.kill();
  if (tempDir.startsWith(path.join(os.tmpdir(), 'sri-square-test-'))) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('creates append-only booking, billing, financial, cash and backup records', async () => {
  const { body: created } = await request('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      serialNumber: 'TEST-001', eventName: 'Test Reception', customerName: 'Test Customer', phone: '9000000000', bookingDate: '2026-09-18', eventDate: '2026-10-10', hallRent: 100000,
      advances: [{ amount: 10000, receivedDate: '2026-09-18', paymentMode: 'Cash' }, { amount: 20000, receivedDate: '2026-09-20', paymentMode: 'UPI' }]
    })
  });
  const bookingId = created.booking.id;
  await request(`/api/bookings/${bookingId}/billing`, { method: 'POST', body: JSON.stringify({ water: 1500, powerUnits: 50, otherCharges: [{ name: 'Catering coordination', amount: 1000, financeIncome: true }], finalPayment: { amount: 5000, paymentMode: 'Cash', receivedDate: '2026-09-25', cleared: true } }) });
  const { body: finance } = await request(`/api/bookings/${bookingId}/finance`, { method: 'POST', body: JSON.stringify({ water: 1500, powerUnits: 50, decorationVendorTotal: 10000, lightingVendorTotal: 2000, expenses: [{ name: 'Technician', amount: 4000 }] }) });
  assert.equal(finance.booking.calculated.customerBillTotal, 103400);
  assert.equal(finance.booking.calculated.customerBalanceDue, 68400);
  assert.equal(finance.booking.calculated.financialTotal, 107000);
  assert.equal(finance.booking.calculated.eventBalance, 83000);

  await request('/api/cash', { method: 'POST', body: JSON.stringify({ date: '2026-09-18', direction: 'credit', reference: 'TEST-001', amount: 10000 }) });
  await request('/api/cash', { method: 'POST', body: JSON.stringify({ date: '2026-09-18', direction: 'debit', details: 'Test expense', amount: 2500 }) });
  const report = await request('/api/reports/cash?from=2026-09-01&to=2026-10-31');
  assert.equal(report.body.creditTotal, 25000);
  assert.equal(report.body.debitTotal, 6500);
  assert.equal(report.body.closingBalance, 18500);

  const revised = await request(`/api/bookings/${bookingId}/revisions`, { method: 'POST', body: JSON.stringify({
    advances: [{ amount: 12000, receivedDate: '2026-09-22', paymentMode: 'Cash' }, { amount: 20000, receivedDate: '2026-09-20', paymentMode: 'UPI' }]
  }) });
  assert.equal(revised.body.booking.calculated.customerBalanceDue, 66400);

  const financeCorrection = await request(`/api/bookings/${bookingId}/finance`, { method: 'POST', body: JSON.stringify({
    water: 1500, powerUnits: 50, decorationVendorTotal: 10000, lightingVendorTotal: 2000, expenses: []
  }) });
  assert.equal(financeCorrection.body.booking.calculated.expenseTotal, 0);
  assert.equal(financeCorrection.body.booking.calculated.eventBalance, 87000);

  const { body: bootstrap } = await request('/api/bootstrap');
  assert.equal(bootstrap.dashboard.cashBalance, 24500);
  assert.equal(bootstrap.dashboard.totalBookingValue, 103400);
  assert.equal(bootstrap.dashboard.customerReceived, 37000);
  assert.equal(bootstrap.cash.filter((entry) => entry.origin === 'booking-automation').length, 6);
  assert.equal(bootstrap.cash.find((entry) => entry.details.includes('Final customer payment')).date, '2026-09-25');
  assert.ok(bootstrap.cash.some((entry) => entry.date === '2026-09-18' && entry.direction === 'debit' && entry.amount === 10000));
  assert.ok(bootstrap.cash.some((entry) => entry.date === '2026-09-22' && entry.direction === 'credit' && entry.amount === 12000));

  const { body: history } = await request(`/api/bookings/${bookingId}/events`);
  assert.deepEqual(history.events.map((event) => event.eventType), ['booking.created', 'billing.revised', 'finance.revised', 'booking.revised', 'finance.revised']);

  const backup = await request('/api/backup/export', { method: 'POST' });
  assert.equal(backup.body.format, 'SRI_SQUARE_EVENT_BACKUP');
  const imported = await request('/api/backup/import', { method: 'POST', body: JSON.stringify(backup.body) });
  assert.equal(imported.body.added, 0);
});

test('enforces overlapping slots across timezones, allows adjacent slots, and frees cancelled capacity', async () => {
  const first = await request('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ serialNumber: 'TZ-001', eventName: 'Timezone Test', customerName: 'First Customer', bookingDate: '2026-11-01', eventStartLocal: '2026-12-01T15:00', eventEndLocal: '2026-12-01T18:00', eventTimezone: 'Asia/Kolkata', hallRent: 1000 })
  });
  const conflict = await requestFailure('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ serialNumber: 'TZ-002', eventName: 'Conflicting Test', customerName: 'Second Customer', bookingDate: '2026-11-01', eventStartLocal: '2026-12-01T13:30', eventEndLocal: '2026-12-01T15:00', eventTimezone: 'Asia/Dubai', hallRent: 1000 })
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.details.conflicts[0].serialNumber, 'TZ-001');

  const availability = await request('/api/availability/check', { method: 'POST', body: JSON.stringify({ eventStartLocal: '2026-12-01T16:30', eventEndLocal: '2026-12-01T18:30', eventTimezone: 'Asia/Dubai' }) });
  assert.equal(availability.body.available, true);
  await request('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ serialNumber: 'TZ-003', eventName: 'Adjacent Test', customerName: 'Third Customer', bookingDate: '2026-11-01', eventStartLocal: '2026-12-01T16:30', eventEndLocal: '2026-12-01T18:30', eventTimezone: 'Asia/Dubai', hallRent: 1000 })
  });

  await request(`/api/bookings/${first.body.booking.id}/cancellations`, { method: 'POST', body: JSON.stringify({ reason: 'Customer changed the event date.' }) });
  const cancelledBilling = await requestFailure(`/api/bookings/${first.body.booking.id}/billing`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(cancelledBilling.response.status, 409);
  const rebook = await request('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ serialNumber: 'TZ-004', eventName: 'Released Slot', customerName: 'Fourth Customer', bookingDate: '2026-11-01', eventStartLocal: '2026-12-01T15:00', eventEndLocal: '2026-12-01T16:00', eventTimezone: 'Asia/Kolkata', hallRent: 1000 })
  });
  assert.equal(rebook.body.booking.status, 'active');
  const blockedRestore = await requestFailure(`/api/bookings/${first.body.booking.id}/reinstatements`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(blockedRestore.response.status, 409);
  await request(`/api/bookings/${rebook.body.booking.id}/cancellations`, { method: 'POST', body: JSON.stringify({ reason: 'Owner released the test slot.' }) });
  const restored = await request(`/api/bookings/${first.body.booking.id}/reinstatements`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(restored.body.booking.status, 'active');

  const dst = await requestFailure('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ serialNumber: 'DST-001', eventName: 'DST Test', customerName: 'DST Customer', bookingDate: '2026-01-01', eventStartLocal: '2026-03-08T02:30', eventEndLocal: '2026-03-08T04:00', eventTimezone: 'America/New_York', hallRent: 1000 })
  });
  assert.equal(dst.response.status, 400);
  assert.match(dst.body.error, /does not exist/);
});

test('opens a Guntur owner workspace without authentication', async () => {
  const removedLogin = await fetch(`${base}/api/auth/login`, { method: 'POST' });
  const removedLogout = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(removedLogin.status, 404);
  assert.equal(removedLogout.status, 404);

  const initial = await request('/api/bootstrap');
  assert.equal(initial.body.owner.role, 'owner');
  assert.equal(initial.body.owner.displayName, 'Sri Square Owner');
  const created = await request('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      serialNumber: 'GNT-001', eventName: 'Guntur Test Event', customerName: 'Staff Test Customer',
      eventStartLocal: '2030-12-01T10:00', eventEndLocal: '2030-12-01T13:00', hallRent: 5000
    })
  });
  assert.equal(created.body.booking.bookingDate, gunturToday());
  assert.equal(created.body.booking.eventTimezone, 'Asia/Kolkata');

  const savedSchedule = await request('/api/backup/schedule', { method: 'POST', body: JSON.stringify({ enabled: true, time: '23:00' }) });
  assert.deepEqual(savedSchedule.body, { enabled: true, time: '23:00' });

  const health = await request('/api/health');
  assert.equal(health.body.status, 'ok');
});

test('imports an original Sri Square PWA backup once without overwriting existing events', async () => {
  const legacyBackup = {
    format: 'SRI SQUARE ACCOUNTS BACKUP',
    data: {
      bookings: [{
        id: 'LEGACY-001', event: 'Legacy Marriage', customer: 'Legacy Customer', phone: '9111111111', bookingDate: '2026-08-01', date: '2026-11-15', rent: 75000,
        a1: 15000, a1Date: '2026-08-01', m1: 'Cash', a2: 5000, a2Date: '2026-08-10', m2: 'UPI', notes: 'Imported from original PWA',
        water: 1000, power: 30, other: [{ name: 'Stage', amount: 2500, financeIncome: true }], final: 10000, finalMode: 'Cash', cleared: true,
        decoVendor: 9000, decoComm: 2700, lightVendor: 3000, lightComm: 900, expenses: [{ name: 'Imported labour', amount: 1500 }]
      }],
      cashLedger: [{ date: '2026-08-01', id: 'LEGACY-001', credit: 15000, debit: 0 }, { date: '2026-08-02', debitName: 'Imported cleaning', credit: 0, debit: 1200 }]
    }
  };
  const first = await request('/api/backup/import', { method: 'POST', body: JSON.stringify(legacyBackup) });
  assert.equal(first.body.format, 'legacy');
  assert.equal(first.body.added, 3);
  const { body: bootstrap } = await request('/api/bootstrap');
  const legacy = bootstrap.bookings.find((booking) => booking.serialNumber === 'LEGACY-001');
  assert.equal(legacy.customerName, 'Legacy Customer');
  assert.equal(legacy.calculated.customerBillTotal, 79040);
  assert.equal(legacy.calculated.eventBalance, 76140);
  const second = await request('/api/backup/import', { method: 'POST', body: JSON.stringify(legacyBackup) });
  assert.equal(second.body.added, 0);
  assert.equal(second.body.alreadyImported, true);
});
