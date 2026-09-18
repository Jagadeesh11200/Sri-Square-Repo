const { readEvents } = require('./database');

const PAYMENT_MODES = new Set(['Cash', 'UPI', 'Company Account', 'Bank Transfer']);
// Sri Square Convention operates in Guntur, Andhra Pradesh (IST, no DST).
const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const timeZoneFormatters = new Map();

function string(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function number(value, fallback = 0, label = 'Amount') {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid number.`);
  return Math.round(parsed);
}

function money(value, label = 'Amount') {
  const parsed = number(value, 0, label);
  if (parsed < 0) throw new Error(`${label} cannot be negative.`);
  return parsed;
}

function paymentMode(value) {
  if (value === '' || value === null || value === undefined) return 'Cash';
  if (!PAYMENT_MODES.has(value)) throw new Error('Choose a valid payment mode.');
  return value;
}

function date(value, fallback = '') {
  const raw = string(value, fallback);
  if (!raw) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('Use a valid date.');
  const parsed = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) throw new Error('Use a real calendar date.');
  return raw;
}

function localDateTime(value, label = 'Event time', fallback = '') {
  const raw = string(value, fallback);
  if (!raw) return fallback;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) throw new Error(`${label} must include a valid local date and time.`);
  const [year, month, day] = match[1].split('-').map(Number);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59) throw new Error(`${label} is not valid.`);
  return `${match[1]}T${match[2]}:${match[3]}`;
}

function nextDate(day) {
  const source = date(day);
  const value = new Date(`${source}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function timeZone(value) {
  const raw = string(value, DEFAULT_TIME_ZONE) || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: raw }).format();
  } catch (_error) {
    throw new Error('Choose a valid IANA timezone, such as Asia/Kolkata.');
  }
  return raw;
}

function formatterFor(zone) {
  if (!timeZoneFormatters.has(zone)) {
    timeZoneFormatters.set(zone, new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23'
    }));
  }
  return timeZoneFormatters.get(zone);
}

function localPartsAt(milliseconds, zone) {
  const pieces = formatterFor(zone).formatToParts(new Date(milliseconds));
  const values = Object.fromEntries(pieces.filter((piece) => piece.type !== 'literal').map((piece) => [piece.type, piece.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function hallLocalNow(now = Date.now()) {
  return localPartsAt(now instanceof Date ? now.getTime() : now, DEFAULT_TIME_ZONE);
}

function todayInHallTimeZone(now = Date.now()) {
  return hallLocalNow(now).slice(0, 10);
}

// Produces a unique instant or explains the DST edge case instead of silently moving the booking.
function zonedDateTimeToUtc(localValue, zone) {
  const local = localDateTime(localValue);
  const [day, clock] = local.split('T');
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  const [hour, minute] = clock.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  const candidates = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = wallClockAsUtc - offsetMinutes * 60_000;
    if (localPartsAt(candidate, zone) === local) candidates.push(candidate);
  }
  const unique = [...new Set(candidates)];
  if (!unique.length) throw new Error(`${local} does not exist in ${zone} because of a daylight-saving transition. Choose another time.`);
  if (unique.length > 1) throw new Error(`${local} is ambiguous in ${zone} because clocks change then. Choose a different time slot.`);
  return unique[0];
}

function scheduleFrom(input = {}, { requireSchedule = false } = {}) {
  const zone = timeZone(input.eventTimezone || input.timezone || DEFAULT_TIME_ZONE);
  let startLocal = localDateTime(input.eventStartLocal || input.eventStart || '', 'Event start');
  let endLocal = localDateTime(input.eventEndLocal || input.eventEnd || '', 'Event end');
  const legacyEventDate = date(input.eventDate || '', '');
  if (!startLocal && !endLocal && legacyEventDate) {
    startLocal = `${legacyEventDate}T15:00`;
    endLocal = `${nextDate(legacyEventDate)}T03:00`;
  }
  if (requireSchedule && (!startLocal || !endLocal)) throw new Error('Event start, end, and timezone are required to reserve the hall.');
  if (!startLocal || !endLocal) return { eventDate: legacyEventDate, eventStartLocal: '', eventEndLocal: '', eventTimezone: zone, eventStartUtc: null, eventEndUtc: null };
  const startUtc = zonedDateTimeToUtc(startLocal, zone);
  const endUtc = zonedDateTimeToUtc(endLocal, zone);
  const durationMinutes = Math.round((endUtc - startUtc) / 60_000);
  if (durationMinutes < 30) throw new Error('A hall booking must be at least 30 minutes long.');
  if (durationMinutes > 24 * 60) throw new Error('A single hall booking cannot exceed 24 hours. Create consecutive bookings if needed.');
  return {
    eventDate: startLocal.slice(0, 10),
    eventStartLocal: startLocal,
    eventEndLocal: endLocal,
    eventTimezone: zone,
    eventStartUtc: new Date(startUtc).toISOString(),
    eventEndUtc: new Date(endUtc).toISOString(),
    durationMinutes
  };
}

function advance(value, index) {
  return {
    id: string(value?.id, `advance-${index + 1}`),
    amount: money(value?.amount, `Advance ${index + 1}`),
    receivedDate: date(value?.receivedDate || ''),
    paymentMode: paymentMode(value?.paymentMode)
  };
}

function otherCharge(value) {
  return {
    id: string(value?.id, cryptoRandomId()),
    name: string(value?.name),
    amount: money(value?.amount, 'Other charge'),
    financeIncome: Boolean(value?.financeIncome)
  };
}

function expense(value) {
  return {
    id: string(value?.id, cryptoRandomId()),
    name: string(value?.name),
    amount: money(value?.amount, 'Expense'),
    paidDate: date(value?.paidDate || ''),
    paymentMode: paymentMode(value?.paymentMode)
  };
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeBooking(input = {}) {
  const serialNumber = string(input.serialNumber).toUpperCase();
  const customerName = string(input.customerName);
  if (!serialNumber) throw new Error('Booking / serial number is required.');
  if (!customerName) throw new Error('Customer name is required.');
  const bookingDate = date(input.bookingDate, todayInHallTimeZone());
  const schedule = scheduleFrom({ ...input, eventDate: input.eventDate || bookingDate }, { requireSchedule: false });
  return {
    serialNumber,
    eventName: string(input.eventName, 'Event'),
    customerName,
    phone: string(input.phone),
    bookingDate,
    ...schedule,
    hallRent: money(input.hallRent, 'Hall rent'),
    advances: [advance(input.advances?.[0], 0), advance(input.advances?.[1], 1)],
    notes: string(input.notes),
    water: money(input.water, 'Water'),
    powerUnits: money(input.powerUnits, 'Power units'),
    otherCharges: Array.isArray(input.otherCharges) ? input.otherCharges.map(otherCharge).filter((item) => item.name || item.amount) : [],
    finalPayment: {
      amount: money(input.finalPayment?.amount, 'Final payment'),
      paymentMode: paymentMode(input.finalPayment?.paymentMode),
      receivedDate: date(input.finalPayment?.receivedDate || ''),
      cleared: Boolean(input.finalPayment?.cleared)
    },
    decorationVendorTotal: money(input.decorationVendorTotal, 'Decoration vendor total'),
    decorationCommission: money(input.decorationCommission, 'Decoration commission'),
    lightingVendorTotal: money(input.lightingVendorTotal, 'Lighting vendor total'),
    lightingCommission: money(input.lightingCommission, 'Lighting commission'),
    expenses: Array.isArray(input.expenses) ? input.expenses.map(expense).filter((item) => item.name || item.amount) : [],
    status: 'active'
  };
}

function normalizeBookingRevision(input = {}) {
  const result = {};
  const direct = ['serialNumber', 'eventName', 'customerName', 'phone', 'bookingDate', 'notes'];
  for (const key of direct) {
    if (key in input) result[key] = key === 'bookingDate' ? date(input[key]) : string(input[key]);
  }
  if ('eventDate' in input) result.eventDate = date(input.eventDate);
  if ('eventStartLocal' in input || 'eventStart' in input) result.eventStartLocal = localDateTime(input.eventStartLocal || input.eventStart, 'Event start');
  if ('eventEndLocal' in input || 'eventEnd' in input) result.eventEndLocal = localDateTime(input.eventEndLocal || input.eventEnd, 'Event end');
  if ('eventTimezone' in input || 'timezone' in input) result.eventTimezone = timeZone(input.eventTimezone || input.timezone);
  if ('hallRent' in input) result.hallRent = money(input.hallRent, 'Hall rent');
  if ('advances' in input && Array.isArray(input.advances)) result.advances = [advance(input.advances[0], 0), advance(input.advances[1], 1)];
  if (!Object.keys(result).length) throw new Error('No booking fields were provided.');
  if (result.serialNumber === '') throw new Error('Booking / serial number is required.');
  if (result.customerName === '') throw new Error('Customer name is required.');
  return result;
}

function scheduleRevision(current, revision) {
  const scheduleKeys = ['eventDate', 'eventStartLocal', 'eventEndLocal', 'eventTimezone'];
  if (!scheduleKeys.some((key) => key in revision)) return revision;
  const next = scheduleFrom({ ...current, ...revision }, { requireSchedule: true });
  return { ...revision, ...next };
}

function normalizeBilling(input = {}) {
  return {
    water: money(input.water, 'Water'),
    powerUnits: money(input.powerUnits, 'Power units'),
    otherCharges: Array.isArray(input.otherCharges) ? input.otherCharges.map(otherCharge).filter((item) => item.name || item.amount) : [],
    finalPayment: {
      amount: money(input.finalPayment?.amount, 'Final payment'),
      paymentMode: paymentMode(input.finalPayment?.paymentMode),
      receivedDate: date(input.finalPayment?.receivedDate || ''),
      cleared: Boolean(input.finalPayment?.cleared)
    }
  };
}

function normalizeFinance(input = {}) {
  const decorationVendorTotal = money(input.decorationVendorTotal, 'Decoration vendor total');
  const lightingVendorTotal = money(input.lightingVendorTotal, 'Lighting vendor total');
  return {
    water: money(input.water, 'Water'),
    powerUnits: money(input.powerUnits, 'Power units'),
    decorationVendorTotal,
    decorationCommission: 'decorationCommission' in input ? money(input.decorationCommission, 'Decoration commission') : Math.round(decorationVendorTotal * 0.3),
    lightingVendorTotal,
    lightingCommission: 'lightingCommission' in input ? money(input.lightingCommission, 'Lighting commission') : Math.round(lightingVendorTotal * 0.3),
    expenses: Array.isArray(input.expenses) ? input.expenses.map(expense).filter((item) => item.name || item.amount) : []
  };
}

function projectBookingEvents(events) {
  const records = new Map();
  for (const event of events) {
    if (event.aggregateType !== 'booking') continue;
    if (event.eventType === 'booking.created') records.set(event.aggregateId, { id: event.aggregateId, ...normalizeBooking(event.payload) });
    const booking = records.get(event.aggregateId);
    if (!booking) continue;
    if (event.eventType === 'booking.revised' || event.eventType === 'billing.revised' || event.eventType === 'finance.revised') Object.assign(booking, event.payload);
    if (event.eventType === 'booking.cancelled') Object.assign(booking, { status: 'cancelled', cancellation: event.payload });
    if (event.eventType === 'booking.reinstated') Object.assign(booking, { status: 'active', reinstatement: event.payload });
    booking.lastChangedAt = event.occurredAt;
  }
  return [...records.values()].map(withCalculations).sort((a, b) => String(a.eventStartUtc || a.eventDate).localeCompare(String(b.eventStartUtc || b.eventDate)));
}

function bookings() {
  return projectBookingEvents(readEvents({ aggregateType: 'booking', limit: 100000 }));
}

function bookingById(id) {
  return bookings().find((booking) => booking.id === id);
}

function withCalculations(booking) {
  const schedule = booking.eventStartUtc && booking.eventEndUtc ? booking : { ...booking, ...scheduleFrom(booking, { requireSchedule: false }) };
  const advances = Array.isArray(schedule.advances) ? schedule.advances : [];
  const otherCharges = Array.isArray(schedule.otherCharges) ? schedule.otherCharges : [];
  const expenses = Array.isArray(schedule.expenses) ? schedule.expenses : [];
  const customerBillTotal = schedule.hallRent + schedule.water + schedule.powerUnits * 18 + otherCharges.reduce((sum, item) => sum + item.amount, 0);
  const advanceTotal = advances.reduce((sum, item) => sum + item.amount, 0);
  const finalReceived = schedule.finalPayment?.cleared ? schedule.finalPayment.amount : 0;
  const receivedTotal = advanceTotal + finalReceived;
  const customerBalanceDue = Math.max(0, customerBillTotal - receivedTotal);
  const customerCredit = Math.max(0, receivedTotal - customerBillTotal);
  const financeIncome = otherCharges.filter((item) => item.financeIncome).reduce((sum, item) => sum + item.amount, 0);
  const financialTotal = schedule.hallRent + schedule.water + schedule.powerUnits * 18 + schedule.decorationCommission + schedule.lightingCommission + financeIncome;
  const expenseTotal = expenses.reduce((sum, item) => sum + item.amount, 0);
  const nonCashAdvances = advances.filter((item) => item.paymentMode !== 'Cash').reduce((sum, item) => sum + item.amount, 0);
  const cashReceived = advances.filter((item) => item.paymentMode === 'Cash').reduce((sum, item) => sum + item.amount, 0) + (schedule.finalPayment?.cleared && schedule.finalPayment?.paymentMode === 'Cash' ? schedule.finalPayment.amount : 0);
  const cashExpenses = expenses.filter((item) => item.paymentMode === 'Cash').reduce((sum, item) => sum + item.amount, 0);
  return {
    ...schedule,
    calculated: { customerBillTotal, advanceTotal, receivedTotal, customerBalanceDue, customerCredit, financeIncome, financialTotal, expenseTotal, nonCashAdvances, cashReceived, cashExpenses, eventBalance: financialTotal - expenseTotal - nonCashAdvances }
  };
}

function bookingCashMovements(booking) {
  const movements = [];
  for (const [index, advanceItem] of (booking.advances || []).entries()) {
    if (advanceItem.paymentMode === 'Cash' && advanceItem.amount) movements.push({
      key: `advance:${advanceItem.id || index + 1}`,
      signedAmount: advanceItem.amount,
      date: advanceItem.receivedDate || booking.bookingDate,
      reference: booking.serialNumber,
      details: `${index + 1}${index === 0 ? 'st' : 'nd'} booking advance`
    });
  }
  if (booking.finalPayment?.cleared && booking.finalPayment?.paymentMode === 'Cash' && booking.finalPayment.amount) movements.push({
    key: 'final-payment', signedAmount: booking.finalPayment.amount, date: booking.finalPayment.receivedDate || booking.bookingDate, reference: booking.serialNumber, details: 'Final customer payment'
  });
  for (const item of booking.expenses || []) {
    if (item.paymentMode === 'Cash' && item.amount) movements.push({
      key: `expense:${item.id}`,
      signedAmount: -item.amount,
      date: item.paidDate || booking.eventDate || booking.bookingDate,
      reference: booking.serialNumber,
      details: item.name || 'Cash expense'
    });
  }
  return movements;
}

function movementDeltas(before, after) {
  const oldMap = new Map(bookingCashMovements(before).map((movement) => [movement.key, movement]));
  const newMap = new Map(bookingCashMovements(after).map((movement) => [movement.key, movement]));
  const changes = [];
  for (const key of new Set([...oldMap.keys(), ...newMap.keys()])) {
    const oldMovement = oldMap.get(key);
    const newMovement = newMap.get(key);
    if (!oldMovement) {
      changes.push({ key, delta: newMovement.signedAmount, movement: newMovement });
      continue;
    }
    if (!newMovement) {
      changes.push({ key, delta: -oldMovement.signedAmount, movement: oldMovement });
      continue;
    }
    const movementMetadataChanged = oldMovement.date !== newMovement.date
      || oldMovement.reference !== newMovement.reference
      || oldMovement.details !== newMovement.details;
    // Ledger entries are immutable. Moving a receipt/expense to another date or changing
    // its ledger description is represented by a reversal and a replacement, not an edit.
    if (movementMetadataChanged) {
      changes.push({ key: `${key}:reversal`, delta: -oldMovement.signedAmount, movement: oldMovement });
      changes.push({ key: `${key}:replacement`, delta: newMovement.signedAmount, movement: newMovement });
      continue;
    }
    const delta = newMovement.signedAmount - oldMovement.signedAmount;
    if (delta) changes.push({ key, delta, movement: newMovement });
  }
  return changes.filter((change) => change.delta !== 0);
}

function availabilityFor(schedule, existingBookings, excludeBookingId = null) {
  if (!schedule.eventStartUtc || !schedule.eventEndUtc) throw new Error('Event start and end are required to check availability.');
  const start = new Date(schedule.eventStartUtc).getTime();
  const end = new Date(schedule.eventEndUtc).getTime();
  const conflicts = existingBookings.filter((booking) => {
    if (booking.id === excludeBookingId || booking.status !== 'active' || !booking.eventStartUtc || !booking.eventEndUtc) return false;
    return start < new Date(booking.eventEndUtc).getTime() && end > new Date(booking.eventStartUtc).getTime();
  }).map((booking) => ({
    id: booking.id,
    serialNumber: booking.serialNumber,
    customerName: booking.customerName,
    eventName: booking.eventName,
    eventStartLocal: booking.eventStartLocal,
    eventEndLocal: booking.eventEndLocal,
    eventTimezone: booking.eventTimezone
  }));
  return { available: conflicts.length === 0, conflicts };
}

function normalizeCashEntry(input = {}) {
  const direction = input.direction === 'debit' ? 'debit' : 'credit';
  const amount = money(input.amount, 'Cash amount');
  if (!amount) throw new Error('Amount must be greater than zero.');
  const reference = string(input.reference);
  const details = string(input.details);
  if (direction === 'credit' && !reference) throw new Error('A cash reference is required for a credit.');
  if (direction === 'debit' && !details) throw new Error('Expense details are required for a debit.');
  return {
    entryId: string(input.entryId, `cash-${cryptoRandomId()}`),
    date: date(input.date, todayInHallTimeZone()),
    direction,
    amount,
    reference,
    details,
    correctionFor: string(input.correctionFor),
    origin: string(input.origin, 'manual'),
    originKey: string(input.originKey)
  };
}

function cashLedger() {
  const events = readEvents({ aggregateType: 'cash', limit: 100000 });
  const entries = events
    .filter((event) => ['cash.entry.recorded', 'cash.adjustment.recorded', 'cash.automatic.recorded'].includes(event.eventType))
    .map((event) => ({ ...event.payload, eventId: event.eventId, occurredAt: event.occurredAt, actorName: event.actorName, eventType: event.eventType }))
    .sort((a, b) => `${a.date}-${a.occurredAt}-${a.eventId}`.localeCompare(`${b.date}-${b.occurredAt}-${b.eventId}`));
  let balance = 0;
  return entries.map((entry) => {
    balance += entry.direction === 'credit' ? entry.amount : -entry.amount;
    return { ...entry, runningBalance: balance };
  });
}

function cashReport(from, to) {
  const all = cashLedger();
  const before = all.filter((entry) => entry.date < from);
  const selected = all.filter((entry) => entry.date >= from && entry.date <= to);
  const openingBalance = before.reduce((sum, entry) => sum + (entry.direction === 'credit' ? entry.amount : -entry.amount), 0);
  const creditTotal = selected.filter((entry) => entry.direction === 'credit').reduce((sum, entry) => sum + entry.amount, 0);
  const debitTotal = selected.filter((entry) => entry.direction === 'debit').reduce((sum, entry) => sum + entry.amount, 0);
  let runningBalance = openingBalance;
  return {
    from, to, openingBalance, creditTotal, debitTotal, closingBalance: openingBalance + creditTotal - debitTotal,
    entries: selected.map((entry) => {
      runningBalance += entry.direction === 'credit' ? entry.amount : -entry.amount;
      return { ...entry, runningBalance };
    })
  };
}

module.exports = {
  DEFAULT_TIME_ZONE,
  hallLocalNow,
  todayInHallTimeZone,
  normalizeBooking,
  normalizeBookingRevision,
  scheduleRevision,
  scheduleFrom,
  normalizeBilling,
  normalizeFinance,
  normalizeCashEntry,
  bookings,
  bookingById,
  cashLedger,
  cashReport,
  projectBookingEvents,
  withCalculations,
  availabilityFor,
  bookingCashMovements,
  movementDeltas
};
