const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {
  db, ROOT, DATA_DIR, id, isoNow, ownerIdentity, appendEvent, readEvents, eventExport
} = require('./database');
const {
  normalizeBooking, normalizeBookingRevision, normalizeBilling, normalizeFinance, normalizeCashEntry,
  scheduleRevision, scheduleFrom, availabilityFor, movementDeltas, hallLocalNow,
  bookings, bookingById, cashLedger, cashReport
} = require('./domain');

const app = express();
const PORT = Number(process.env.PORT || 3030);
const PUBLIC_DIR = path.join(ROOT, 'public');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const OWNER = ownerIdentity();

fs.mkdirSync(BACKUP_DIR, { recursive: true });

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Cache-Control': req.path.startsWith('/api/') ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin'
  });
  next();
});
app.use(express.json({ limit: '20mb' }));
app.use('/api', (req, _res, next) => {
  req.owner = OWNER;
  req.requestId = req.headers['x-request-id'] || id('req');
  next();
});

function action(req, type, payload = {}, aggregateType = 'activity', aggregateId = id('act')) {
  return appendEvent({
    aggregateType,
    aggregateId,
    eventType: type,
    actorId: req.owner.id,
    requestId: req.requestId || null,
    payload
  });
}

function respondError(res, error, code = 400) {
  const status = error.status || code;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || 'Something went wrong.', details: error.details });
}

function conflictError(conflicts) {
  const error = new Error(`This time slot conflicts with ${conflicts.map((booking) => booking.serialNumber).join(', ')}. Choose a free slot or cancel the existing booking first.`);
  error.status = 409;
  error.details = { conflicts };
  return error;
}

function requireActiveBooking(booking) {
  if (!booking) {
    const error = new Error('Booking not found.');
    error.status = 404;
    throw error;
  }
  if (booking.status !== 'active') {
    const error = new Error('Cancelled bookings are read-only. Create a new booking for a new reservation.');
    error.status = 409;
    throw error;
  }
  return booking;
}

function verifyAvailability(record, excludeBookingId = null) {
  const availability = availabilityFor(record, bookings(), excludeBookingId);
  if (!availability.available) throw conflictError(availability.conflicts);
  return availability;
}

function recordAutomaticCashDeltas(req, before, after, reason) {
  for (const change of movementDeltas(before, after)) {
    const entry = normalizeCashEntry({
      entryId: id('cash-auto'),
      date: change.movement.date || after.bookingDate,
      direction: change.delta > 0 ? 'credit' : 'debit',
      amount: Math.abs(change.delta),
      reference: change.movement.reference || after.serialNumber,
      details: `${reason}: ${change.movement.details}`,
      correctionFor: `booking:${after.id}:${change.key}`,
      origin: 'booking-automation',
      originKey: `booking:${after.id}:${change.key}`
    });
    appendEvent({
      aggregateType: 'cash',
      aggregateId: entry.entryId,
      eventType: 'cash.automatic.recorded',
      actorId: req.owner.id,
      requestId: req.requestId,
      source: 'automation',
      payload: entry
    });
  }
}

// A booking revision and the cash movements it causes are a single accounting
// action.  SQLite rolls both back if any one append fails, so the dashboard and
// cash ledger can never be left showing half of a correction.
function appendBookingWithCash(req, { before, eventType, payload, bookingId, reason }) {
  return db.transaction(() => {
    const event = action(req, eventType, payload, 'booking', bookingId);
    const updated = bookingById(bookingId);
    recordAutomaticCashDeltas(req, before, updated, reason);
    return { event, booking: bookingById(bookingId) };
  })();
}

function bookingDashboard() {
  const records = bookings().filter((booking) => booking.status === 'active');
  const cash = cashLedger();
  const cashBalance = cash.length ? cash[cash.length - 1].runningBalance : 0;
  const totalDebits = cash.filter((entry) => entry.direction === 'debit').reduce((sum, entry) => sum + entry.amount, 0);
  const now = Date.now();
  const upcoming = records.filter((booking) => booking.eventEndUtc && new Date(booking.eventEndUtc).getTime() >= now)
    .sort((a, b) => String(a.eventStartUtc).localeCompare(String(b.eventStartUtc)));
  return {
    totalBookings: records.length,
    totalBookingValue: records.reduce((sum, booking) => sum + booking.calculated.customerBillTotal, 0),
    balanceDue: records.reduce((sum, booking) => sum + booking.calculated.customerBalanceDue, 0),
    customerCredit: records.reduce((sum, booking) => sum + booking.calculated.customerCredit, 0),
    customerReceived: records.reduce((sum, booking) => sum + booking.calculated.receivedTotal, 0),
    financialBalance: records.reduce((sum, booking) => sum + booking.calculated.eventBalance, 0),
    cashBalance,
    totalDebits,
    cancelledBookings: bookings().filter((booking) => booking.status === 'cancelled').length,
    upcoming: upcoming.slice(0, 5)
  };
}

function activityFeed(limit = 40) {
  return readEvents({ limit }).slice().reverse().map((event) => ({
    ...event,
    summary: eventSummary(event)
  }));
}

function eventSummary(event) {
  const labels = {
    'booking.created': 'Created booking',
    'booking.revised': 'Revised booking',
    'booking.cancelled': 'Cancelled booking',
    'booking.reinstated': 'Restored booking',
    'billing.revised': 'Saved customer billing',
    'finance.revised': 'Saved internal financials',
    'cash.entry.recorded': 'Recorded cash entry',
    'cash.adjustment.recorded': 'Recorded cash adjustment',
    'cash.automatic.recorded': 'Posted booking cash movement',
    'availability.checked': 'Checked hall availability',
    'backup.exported': 'Exported backup',
    'backup.imported': 'Imported backup',
    'backup.schedule.changed': 'Changed backup schedule',
    'backup.automatic.created': 'Created scheduled backup',
    'screen.viewed': 'Viewed screen',
    'report.viewed': 'Viewed report',
    'user.logged_in': 'Signed in',
    'user.logged_out': 'Signed out'
  };
  return labels[event.eventType] || event.eventType.replaceAll('.', ' ');
}

function uniqueSerial(serialNumber, exceptId = null) {
  const match = bookings().find((booking) => booking.serialNumber.toLowerCase() === serialNumber.toLowerCase() && booking.id !== exceptId);
  if (match) throw new Error(`Booking number ${serialNumber} already exists.`);
}

app.get('/api/bootstrap', (req, res) => {
  res.json({ owner: req.owner, dashboard: bookingDashboard(), bookings: bookings(), cash: cashLedger(), activity: activityFeed(), backupSchedule: scheduledBackupSetting() });
});

app.post('/api/actions', (req, res) => {
  const type = String(req.body.type || '');
  if (!['screen.viewed', 'report.viewed'].includes(type)) return res.status(400).json({ error: 'Unsupported audit action.' });
  action(req, type, { screen: String(req.body.screen || '').slice(0, 80) });
  res.status(204).end();
});

app.get('/api/bookings/:id/events', (req, res) => {
  const record = bookingById(req.params.id);
  if (!record) return res.status(404).json({ error: 'Booking not found.' });
  res.json({ booking: record, events: readEvents({ aggregateType: 'booking', aggregateId: req.params.id, limit: 5000 }) });
});

app.post('/api/availability/check', (req, res) => {
  try {
    const schedule = scheduleFrom(req.body, { requireSchedule: true });
    const availability = availabilityFor(schedule, bookings(), String(req.body.excludeBookingId || '') || null);
    action(req, 'availability.checked', { ...schedule, available: availability.available, conflicts: availability.conflicts.map((booking) => booking.serialNumber) }, 'availability', id('availability'));
    res.json({ schedule, ...availability });
  } catch (error) {
    respondError(res, error);
  }
});

app.post('/api/bookings', (req, res) => {
  try {
    const record = normalizeBooking(req.body);
    uniqueSerial(record.serialNumber);
    verifyAvailability(record);
    const bookingId = id('booking');
    const committed = appendBookingWithCash(req, {
      before: { id: bookingId, advances: [], expenses: [], finalPayment: {} },
      eventType: 'booking.created', payload: record, bookingId, reason: 'Booking created'
    });
    res.status(201).json(committed);
  } catch (error) {
    respondError(res, error);
  }
});

app.post('/api/bookings/:id/revisions', (req, res) => {
  try {
    const current = bookingById(req.params.id);
    requireActiveBooking(current);
    const revision = scheduleRevision(current, normalizeBookingRevision(req.body));
    if (revision.serialNumber) uniqueSerial(revision.serialNumber, current.id);
    const next = { ...current, ...revision };
    verifyAvailability(next, current.id);
    const committed = appendBookingWithCash(req, {
      before: current, eventType: 'booking.revised', payload: revision, bookingId: current.id, reason: 'Booking revision'
    });
    res.json({ booking: committed.booking });
  } catch (error) {
    respondError(res, error);
  }
});

app.post('/api/bookings/:id/billing', (req, res) => {
  try {
    const current = requireActiveBooking(bookingById(req.params.id));
    const revision = normalizeBilling(req.body);
    const committed = appendBookingWithCash(req, {
      before: current, eventType: 'billing.revised', payload: revision, bookingId: req.params.id, reason: 'Customer billing revision'
    });
    res.json({ booking: committed.booking });
  } catch (error) {
    respondError(res, error);
  }
});

app.post('/api/bookings/:id/finance', (req, res) => {
  try {
    const current = requireActiveBooking(bookingById(req.params.id));
    const revision = normalizeFinance(req.body);
    const committed = appendBookingWithCash(req, {
      before: current, eventType: 'finance.revised', payload: revision, bookingId: req.params.id, reason: 'Financial revision'
    });
    res.json({ booking: committed.booking });
  } catch (error) {
    respondError(res, error);
  }
});

app.post('/api/bookings/:id/cancellations', (req, res) => {
  try {
    const current = requireActiveBooking(bookingById(req.params.id));
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) throw new Error('Provide a short cancellation reason for the audit record.');
    action(req, 'booking.cancelled', { reason, cancelledAt: isoNow() }, 'booking', current.id);
    res.json({ booking: bookingById(current.id) });
  } catch (error) {
    respondError(res, error);
  }
});

app.post('/api/bookings/:id/reinstatements', (req, res) => {
  try {
    const current = bookingById(req.params.id);
    if (!current) {
      const error = new Error('Booking not found.');
      error.status = 404;
      throw error;
    }
    if (current.status !== 'cancelled') {
      const error = new Error('Only an archived booking can be restored.');
      error.status = 409;
      throw error;
    }
    verifyAvailability({ ...current, status: 'active' });
    action(req, 'booking.reinstated', { restoredAt: isoNow(), previousCancellation: current.cancellation?.reason || '' }, 'booking', current.id);
    res.json({ booking: bookingById(current.id) });
  } catch (error) {
    respondError(res, error);
  }
});

app.post('/api/cash', (req, res) => {
  try {
    const entry = normalizeCashEntry(req.body);
    action(req, 'cash.entry.recorded', entry, 'cash', entry.entryId);
    res.status(201).json({ entry, cash: cashLedger() });
  } catch (error) {
    respondError(res, error);
  }
});

app.post('/api/cash/adjustments', (req, res) => {
  try {
    const entry = normalizeCashEntry({ ...req.body, entryId: id('cash-adjustment'), correctionFor: req.body.correctionFor });
    if (!entry.correctionFor) throw new Error('Select an original cash entry to adjust.');
    action(req, 'cash.adjustment.recorded', entry, 'cash', entry.entryId);
    res.status(201).json({ entry, cash: cashLedger() });
  } catch (error) {
    respondError(res, error);
  }
});

app.get('/api/reports/cash', (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return res.status(400).json({ error: 'Select a valid date range.' });
  action(req, 'report.viewed', { screen: 'cash-report', from, to }, 'report', `cash-${from}-${to}`);
  res.json(cashReport(from, to));
});

app.post('/api/backup/export', (req, res) => {
  const payload = { format: 'SRI_SQUARE_EVENT_BACKUP', version: 1, createdAt: isoNow(), exportedBy: req.owner.displayName, events: eventExport() };
  action(req, 'backup.exported', { eventCount: payload.events.length }, 'backup', id('backup'));
  res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="sri-square-backup-${payload.createdAt.slice(0, 10)}.json"` });
  res.send(JSON.stringify(payload, null, 2));
});

app.post('/api/backup/import', (req, res) => {
  try {
    if (req.body?.format === 'SRI SQUARE ACCOUNTS BACKUP' || Array.isArray(req.body?.data?.bookings)) {
      const result = importLegacyBackup(req.body, req);
      return res.json({ ...result, dashboard: bookingDashboard() });
    }
    const imported = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!imported.length || imported.length > 100000) throw new Error('Backup must include between 1 and 100,000 events.');
    const userIds = new Set(db.prepare('SELECT id FROM users').all().map((row) => row.id));
    const insert = db.prepare(`INSERT OR IGNORE INTO domain_events
      (event_id, aggregate_type, aggregate_id, event_type, actor_id, occurred_at, request_id, source, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const apply = db.transaction(() => {
      let added = 0;
      for (const event of imported) {
        if (!event?.eventId || !event?.aggregateType || !event?.aggregateId || !event?.eventType || !event?.occurredAt) throw new Error('Backup contains an invalid event.');
        const result = insert.run(String(event.eventId), String(event.aggregateType), String(event.aggregateId), String(event.eventType), userIds.has(event.actorId) ? event.actorId : null, String(event.occurredAt), event.requestId || null, 'backup-import', JSON.stringify(event.payload || {}));
        added += result.changes;
      }
      return added;
    });
    const added = apply();
    action(req, 'backup.imported', { received: imported.length, added }, 'backup', id('backup'));
    res.json({ received: imported.length, added, dashboard: bookingDashboard() });
  } catch (error) {
    respondError(res, error);
  }
});

function importLegacyBackup(backup, req) {
  const legacy = backup?.data || backup;
  const legacyBookings = Array.isArray(legacy.bookings) ? legacy.bookings : [];
  const legacyCash = Array.isArray(legacy.cashLedger) ? legacy.cashLedger : [];
  if (!legacyBookings.length && !legacyCash.length) throw new Error('This legacy backup contains no bookings or cash entries.');

  // The deterministic signature makes retrying the same legacy backup additive and idempotent.
  const signature = crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex').slice(0, 24);
  const markerId = `legacy-import-${signature}`;
  const alreadyImported = db.prepare('SELECT 1 FROM domain_events WHERE event_id = ?').get(markerId);
  if (alreadyImported) return { format: 'legacy', received: legacyBookings.length + legacyCash.length, added: 0, skipped: legacyBookings.length + legacyCash.length, alreadyImported: true };

  const existingSerials = new Set(bookings().map((booking) => booking.serialNumber.toLowerCase()));
  const insert = db.prepare(`INSERT OR IGNORE INTO domain_events
    (event_id, aggregate_type, aggregate_id, event_type, actor_id, occurred_at, request_id, source, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const migrate = db.transaction(() => {
    let added = 0;
    let skipped = 0;
    const occurredAt = isoNow();
    for (const [index, old] of legacyBookings.entries()) {
      const serialNumber = String(old.id || old.serialNumber || `LEGACY-${index + 1}`).trim().toUpperCase();
      if (!serialNumber || existingSerials.has(serialNumber.toLowerCase())) { skipped += 1; continue; }
      const payload = normalizeBooking({
        serialNumber,
        eventName: old.event || old.eventName || 'Event',
        customerName: old.customer || old.customerName || 'Legacy Customer',
        phone: old.phone,
        bookingDate: old.bookingDate || String(old.createdAt || '').slice(0, 10) || old.date,
        eventDate: old.date || old.eventDate,
        hallRent: old.rent || old.hallRent,
        advances: [
          { amount: old.a1, receivedDate: old.a1Date || old.bookingDate, paymentMode: old.m1 || 'Cash' },
          { amount: old.a2, receivedDate: old.a2Date || old.bookingDate, paymentMode: old.m2 || 'Cash' }
        ],
        notes: old.notes,
        water: old.water,
        powerUnits: old.power || old.powerUnits,
        otherCharges: old.other || old.otherCharges,
        finalPayment: { amount: old.final || old.finalPayment?.amount, paymentMode: old.finalMode || old.finalPayment?.paymentMode || 'Cash', cleared: old.cleared || old.finalPayment?.cleared },
        decorationVendorTotal: old.decoVendor || old.decorationVendorTotal,
        decorationCommission: old.decoComm || old.decorationCommission,
        lightingVendorTotal: old.lightVendor || old.lightingVendorTotal,
        lightingCommission: old.lightComm || old.lightingCommission,
        expenses: old.expenses || []
      });
      const bookingId = `legacy-booking-${signature}-${index + 1}`;
      const result = insert.run(`legacy-booking-event-${signature}-${index + 1}`, 'booking', bookingId, 'booking.created', req.owner.id, occurredAt, req.requestId, 'legacy-import', JSON.stringify(payload));
      added += result.changes;
      existingSerials.add(serialNumber.toLowerCase());
    }
    for (const [index, old] of legacyCash.entries()) {
      const credit = Number(old.credit || 0);
      const debit = Number(old.debit || 0);
      const direction = credit > 0 ? 'credit' : 'debit';
      const amount = credit > 0 ? credit : debit;
      if (!amount) { skipped += 1; continue; }
      const entry = normalizeCashEntry({
        entryId: `legacy-cash-${signature}-${index + 1}`,
        date: old.date || String(old.createdAt || '').slice(0, 10),
        direction,
        amount,
        reference: credit > 0 ? old.id || `LEGACY-CASH-${index + 1}` : '',
        details: debit > 0 ? old.debitName || old.details || 'Legacy cash expense' : '',
        correctionFor: ''
      });
      const result = insert.run(`legacy-cash-event-${signature}-${index + 1}`, 'cash', entry.entryId, 'cash.entry.recorded', req.owner.id, occurredAt, req.requestId, 'legacy-import', JSON.stringify(entry));
      added += result.changes;
    }
    insert.run(markerId, 'backup', markerId, 'backup.legacy.imported', req.owner.id, occurredAt, req.requestId, 'legacy-import', JSON.stringify({ signature, bookingCount: legacyBookings.length, cashCount: legacyCash.length, added, skipped }));
    return { added, skipped };
  });
  const result = migrate();
  return { format: 'legacy', received: legacyBookings.length + legacyCash.length, ...result, alreadyImported: false };
}

app.post('/api/backup/schedule', (req, res) => {
  const enabled = Boolean(req.body.enabled);
  const time = String(req.body.time || '23:00');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'Use a valid 24-hour backup time.' });
  action(req, 'backup.schedule.changed', { enabled, time }, 'settings', 'backup-schedule');
  res.json({ enabled, time });
});

app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'available', time: isoNow() });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

function scheduledBackupSetting() {
  const events = readEvents({ aggregateType: 'settings', aggregateId: 'backup-schedule', limit: 100 });
  const latest = events.at(-1);
  return latest?.eventType === 'backup.schedule.changed' ? latest.payload : { enabled: false, time: '23:00' };
}

function createAutomaticBackup() {
  const setting = scheduledBackupSetting();
  const localNow = hallLocalNow();
  const localTime = localNow.slice(11, 16);
  const dateKey = localNow.slice(0, 10);
  if (!setting.enabled || setting.time !== localTime) return;
  const alreadyCreated = readEvents({ aggregateType: 'backup', limit: 5000 })
    .some((event) => event.eventType === 'backup.automatic.created' && event.payload.date === dateKey);
  if (alreadyCreated) return;
  const payload = { format: 'SRI_SQUARE_EVENT_BACKUP', version: 1, createdAt: isoNow(), automated: true, events: eventExport() };
  const file = path.join(BACKUP_DIR, `sri-square-auto-${dateKey}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  appendEvent({ aggregateType: 'backup', aggregateId: id('backup'), eventType: 'backup.automatic.created', source: 'system', payload: { date: dateKey, filename: path.basename(file), eventCount: payload.events.length } });
}

setInterval(() => {
  try { createAutomaticBackup(); } catch (error) { console.error('Scheduled backup failed:', error.message); }
}, 30_000).unref();
// Also evaluate once on startup. Without this, a server started late in the
// configured minute could wait past that minute and miss the day's backup.
try { createAutomaticBackup(); } catch (error) { console.error('Scheduled backup failed:', error.message); }

app.get('/icon-192.png', (_req, res) => res.sendFile(path.join(ROOT, 'icon-192.png')));
app.get('/icon-512.png', (_req, res) => res.sendFile(path.join(ROOT, 'icon-512.png')));
app.use(express.static(PUBLIC_DIR));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`Sri Square Operations is running at http://localhost:${PORT}`);
});
