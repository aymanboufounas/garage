import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/app.mjs';
import { id, openDatabase } from '../server/core.mjs';
import { drivingDirections } from '../web/arrival-ui.js';

const ORIGIN = 'http://localhost';
const PASSWORD = 'Test fixture password only 123!';
const DAY = 86400000;

async function setup(t, filename = ':memory:') {
  const db = openDatabase(filename);
  const app = makeApp({ db, origin: ORIGIN });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    db.close();
  });
  function client() {
    return {
      cookie: '', csrf: '', user: null,
      async call(path, data, overrides = {}) {
        const headers = { Cookie: this.cookie, Origin: ORIGIN, ...overrides };
        if (data !== undefined) {
          headers['Content-Type'] = 'application/json';
          headers['X-CSRF-Token'] = overrides['X-CSRF-Token'] ?? this.csrf;
        }
        const response = await fetch(base + path, {
          method: data === undefined ? 'GET' : 'POST', headers,
          body: data === undefined ? undefined : JSON.stringify(data)
        });
        const cookie = response.headers.get('set-cookie');
        if (cookie) this.cookie = cookie.split(';')[0];
        const json = await response.json();
        if (json.csrf) this.csrf = json.csrf;
        return { status: response.status, json, headers: response.headers };
      },
      async register(name) {
        await this.call('/session');
        const r = await this.call('/register', {
          email: `${name.toLowerCase()}@example.com`, name, password: PASSWORD, staff_role: 'admin'
        });
        assert.equal(r.status, 201);
        assert.equal(r.json.user.staff_role, undefined);
        this.user = r.json.user;
        return this;
      },
      async signIn() {
        await this.call('/session');
        const r = await this.call('/login', { email: this.user.email, password: PASSWORD });
        assert.equal(r.status, 200);
        return r.json.user;
      }
    };
  }
  async function garage(host, name) {
    const r = await host.call('/host/garages', {
      name, city: 'Nador', area: 'Centre', address: 'Private entrance 27, fixture only',
      latitude: 35.168126, longitude: -2.929126, hourly_cents: 1800, monthly_cents: 95000,
      height_cm: 230, vehicle_size: 'suv', covered: true,
      description: 'A test space with a covered entrance for a car.'
    });
    assert.equal(r.status, 201);
    db.prepare("UPDATE garages SET status='approved' WHERE id=?").run(r.json.id);
    return r.json.id;
  }
  return { db, client, garage };
}

test('garage directions are private to the renter while a confirmed booking is active', async t => {
  const { db, client, garage } = await setup(t);
  const [renter, host, stranger] = await Promise.all(['Renter', 'Host', 'Stranger'].map(name => client().register(name)));
  const garageId = await garage(host, 'Arrival fixture');
  const booking = { garage_id: garageId, mode: 'hourly', units: 2,
    starts_at: new Date(Date.now() + DAY).toISOString(), request_key: id() };
  const offer = await renter.call('/reservations', { ...booking, action: 'offer', total_cents: 3600 });
  assert.equal(offer.status, 201);
  const reservationId = offer.json.reservation.id;
  const path = `/reservations/${reservationId}`;
  const arrival = `${path}/arrival`;
  assert.equal((await client().call(arrival)).status, 401);
  assert.equal((await renter.call(arrival)).status, 409);
  assert.equal((await host.call(`${path}/accept`, {})).status, 200);
  assert.equal((await stranger.call(arrival)).status, 404);
  assert.equal((await host.call(arrival)).status, 404);
  const confirmed = await renter.call(arrival);
  assert.equal(confirmed.status, 200);
  assert.match(confirmed.headers.get('cache-control'), /no-store/);
  assert.deepEqual(confirmed.json, { arrival: {
    garage_name: 'Arrival fixture', address: 'Private entrance 27, fixture only',
    latitude: 35.168126, longitude: -2.929126
  } });
  assert.equal((await renter.call(`${path}/cancel`, {})).status, 200);
  assert.equal((await renter.call(arrival)).status, 409);

  const rebooked = await renter.call('/reservations', { ...booking, action: 'book', request_key: id() });
  assert.equal(rebooked.status, 201);
  const endedId = rebooked.json.reservation.id;
  db.prepare('UPDATE reservations SET starts_at=?,ends_at=? WHERE id=?').run(Date.now() - DAY, Date.now() - 1, endedId);
  assert.equal((await renter.call(`/reservations/${endedId}/arrival`)).status, 409);
  for (const row of (await renter.call('/reservations')).json.reservations) {
    assert.equal(row.address, undefined);
    assert.equal(row.latitude, undefined);
    assert.equal(row.longitude, undefined);
  }
});

test('driving directions target the entrance and let Google Maps choose the origin', () => {
  const url = new URL(drivingDirections(35.168126, -2.929126));
  assert.equal(url.origin + url.pathname, 'https://www.google.com/maps/dir/');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    api: '1', destination: '35.168126,-2.929126', travelmode: 'driving', dir_action: 'navigate'
  });
  assert.throws(() => drivingDirections(NaN, 0));
  assert.throws(() => drivingDirections(0, 181));
});

test('multi-garage bidding authorizes each actor and confirms exactly one agreed quote', async t => {
  const { db, client, garage } = await setup(t);
  const [guest, hostA, hostB, stranger] = await Promise.all(['Guest', 'HostA', 'HostB', 'Stranger'].map(name => client().register(name)));
  const a = await garage(hostA, 'Garage Alpha');
  const b = await garage(hostB, 'Garage Beta');
  const input = {
    city: 'Nador', garage_ids: [a, b], mode: 'monthly', units: 1,
    starts_at: new Date(Date.now() + 20 * DAY).toISOString(), proposed_cents: 88000, request_key: id()
  };
  let request, quoteA, quoteB;
  await t.test('requests are atomic, idempotent and restricted to eligible garages', async () => {
    assert.equal((await guest.call('/deals', { ...input, garage_ids: [a, a] })).status, 422);
    assert.equal((await guest.call('/deals', { ...input, city: 'Fes' })).status, 404);
    assert.equal((await hostA.call('/deals', input)).status, 409);
    const first = await guest.call('/deals', input);
    assert.equal(first.status, 200);
    request = first.json.request;
    assert.equal((await guest.call('/deals', input)).json.request.id, request.id);
    assert.equal(request.quotes.length, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM rental_requests').get().count, 1);
    assert.ok(request.ends_at > request.starts_at + 27 * DAY);
    assert.equal(JSON.stringify(request).includes('Private entrance'), false);
    assert.equal(request.quotes.some(q => 'latitude' in q || 'address' in q), false);
    quoteA = request.quotes.find(q => q.garage_id === a);
    quoteB = request.quotes.find(q => q.garage_id === b);
  });
  await t.test('hosts only see and reply to their own invitations', async () => {
    const yours = (await hostA.call('/host/deals')).json.quotes;
    assert.deepEqual(yours.map(q => q.id), [quoteA.id]);
    assert.deepEqual((await stranger.call('/host/deals')).json.quotes, []);
    assert.deepEqual((await hostA.call('/deals')).json.requests, []);
    assert.equal((await hostA.call(`/host/deals/${quoteB.id}/respond`, { action: 'match' })).status, 404);
    assert.equal((await stranger.call(`/deals/${request.id}/cancel`, {})).status, 404);
    assert.equal((await hostB.call(`/host/deals/${quoteB.id}/respond`, { action: 'counter', total_cents: -500 })).status, 422);
    assert.equal((await hostA.call(`/host/deals/${quoteA.id}/respond`, { action: 'match' })).status, 200);
    assert.equal((await hostB.call(`/host/deals/${quoteB.id}/respond`, { action: 'counter', total_cents: 91000 })).status, 200);
    assert.equal(db.prepare('SELECT count(*) AS count FROM reservations').get().count, 0);
  });
  await t.test('price tampering fails and competing selections produce a single booking', async () => {
    const path = `/deals/${request.id}/select`;
    assert.equal((await stranger.call(path, { quote_id: quoteA.id, total_cents: 88000 })).status, 404);
    assert.equal((await guest.call(path, { quote_id: quoteA.id, total_cents: 100 })).status, 409);
    const picks = [{ quote_id: quoteA.id, total_cents: 88000 }, { quote_id: quoteB.id, total_cents: 91000 }];
    const results = await Promise.all(picks.map(pick => guest.call(path, pick)));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const winningIndex = results.findIndex(result => result.status === 200);
    const bookingId = results[winningIndex].json.reservation_id;
    assert.equal((await guest.call(path, picks[winningIndex])).json.reservation_id, bookingId);
    const bookings = (await guest.call('/reservations')).json.reservations;
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].id, bookingId);
    assert.equal(bookings[0].total_cents, picks[winningIndex].total_cents);
    assert.equal(bookings[0].status, 'confirmed');
    assert.match(bookings[0].address, /Private entrance/);
    assert.equal((await guest.call('/deals')).json.requests[0].status, 'booked');
  });
  await t.test('withdrawn, expired and newly occupied quotes cannot be booked', async () => {
    const next = { ...input, mode: 'hourly', units: 3, proposed_cents: 4500,
      starts_at: new Date(Date.now() + 80 * DAY).toISOString(), request_key: id() };
    const r = (await guest.call('/deals', next)).json.request;
    const qa = r.quotes.find(q => q.garage_id === a);
    const qb = r.quotes.find(q => q.garage_id === b);
    const respond = q => `/host/deals/${q.id}/respond`;
    assert.equal((await hostA.call(respond(qa), { action: 'match' })).status, 200);
    assert.equal((await hostB.call(respond(qb), { action: 'match' })).status, 200);
    assert.equal((await hostB.call(respond(qb), { action: 'decline' })).status, 200);
    assert.equal((await guest.call(`/deals/${r.id}/select`, { quote_id: qb.id, total_cents: 4500 })).status, 409);
    const booked = await stranger.call('/reservations', { ...next, garage_id: a, action: 'book', request_key: id() });
    assert.equal(booked.status, 201);
    assert.equal((await guest.call(`/deals/${r.id}/select`, { quote_id: qa.id, total_cents: 4500 })).status, 409);
    db.prepare('UPDATE rental_requests SET expires_at=? WHERE id=?').run(Date.now() - 1, r.id);
    assert.equal((await guest.call(`/deals/${r.id}/cancel`, {})).status, 409);
    assert.equal((await guest.call('/deals')).json.requests.find(row => row.id === r.id).status, 'expired');
  });
});

test('support protects private conversations and provides a staff-managed queue', async t => {
  const { db, client, garage } = await setup(t);
  const [guest, host, stranger, admin, agent] = await Promise.all(['Guest', 'Host', 'Stranger', 'Admin', 'Agent'].map(name => client().register(name)));
  db.prepare('INSERT INTO staff_members (user_id,role) VALUES (?,?)').run(admin.user.id, 'admin');
  db.prepare('INSERT INTO staff_members (user_id,role) VALUES (?,?)').run(agent.user.id, 'support');
  const garageId = await garage(host, 'Test support garage');
  const reservation = await guest.call('/reservations', { garage_id: garageId, mode: 'hourly', units: 2,
    starts_at: new Date(Date.now() + 3 * DAY).toISOString(), action: 'book', request_key: id() });
  assert.equal(reservation.status, 201);
  const form = { reservation_id: reservation.json.reservation.id, subject: 'Access question', category: 'booking',
    message: 'Please help with <img src=x onerror=alert(1)>.', request_key: id() };
  let ticket;
  await t.test('customers only attach their own bookings and see their own tickets', async () => {
    assert.equal((await stranger.call('/support/tickets', form)).status, 404);
    assert.equal((await client().call('/support/tickets')).status, 401);
    const opened = await guest.call('/support/tickets', form);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get('cache-control'), 'no-store');
    ticket = opened.json.ticket;
    assert.equal(ticket.reservation.id, form.reservation_id);
    assert.equal(ticket.reservation.address, undefined);
    assert.equal(ticket.messages[0].message, form.message);
    assert.equal((await guest.call('/support/tickets', form)).json.ticket.id, ticket.id);
    assert.equal((await stranger.call(`/support/tickets/${ticket.id}`)).status, 404);
    assert.equal((await host.call(`/support/tickets/${ticket.id}`)).status, 404);
    assert.equal((await stranger.call(`/support/tickets/${ticket.id}/reply`, { message: 'Forged reply', request_key: id() })).status, 404);
    assert.equal((await guest.call('/staff/queue')).status, 403);
    assert.equal((await client().call('/staff/queue')).status, 401);
  });
  await t.test('staff can find and assign a ticket while ordinary accounts cannot alter it', async () => {
    const queue = await admin.call('/staff/queue?status=open&q=Access');
    assert.equal(queue.status, 200);
    assert.deepEqual(queue.json.tickets.map(row => row.id), [ticket.id]);
    assert.equal((await admin.call("/staff/queue?q='OR%201=1")).json.tickets.length, 0);
    const path = `/staff/tickets/${ticket.id}`;
    const update = { status: 'open', assignee_id: admin.user.id, updated_at: ticket.updated_at };
    assert.equal((await agent.call(path + '/update', update)).status, 403);
    assert.equal((await guest.call(path + '/update', update)).status, 403);
    assert.equal((await admin.call(path + '/update', update, { 'X-CSRF-Token': 'forged' })).status, 403);
    const assigned = await admin.call(path + '/update', { ...update, assignee_id: agent.user.id });
    assert.equal(assigned.status, 200);
    ticket = assigned.json.ticket;
    assert.equal(ticket.assignee_id, agent.user.id);
    assert.equal(ticket.customer.email, guest.user.email);
    assert.equal((await agent.call('/staff/queue?mine=1')).json.tickets.length, 1);
  });
  await t.test('staff reply and resolve, and a customer reply reopens without exposing staff identities', async () => {
    const staff = `/staff/tickets/${ticket.id}`;
    const own = `/support/tickets/${ticket.id}`;
    const reply = { updated_at: ticket.updated_at, message: 'We are looking into the booking.', request_key: id() };
    const replied = await agent.call(staff + '/reply', reply);
    assert.equal(replied.status, 200);
    assert.equal(replied.json.ticket.status, 'waiting');
    assert.equal((await agent.call(staff + '/reply', reply)).json.ticket.messages.length, 2);
    assert.equal((await admin.call(staff + '/update', { status: 'resolved', updated_at: ticket.updated_at })).status, 409);
    const resolved = await agent.call(staff + '/update', { status: 'resolved', updated_at: replied.json.ticket.updated_at });
    assert.equal(resolved.json.ticket.status, 'resolved');
    const reopened = await guest.call(own + '/reply', { message: 'I still need help with this trip.', request_key: id(), author_kind: 'staff' });
    assert.equal(reopened.json.ticket.status, 'open');
    assert.equal(reopened.json.ticket.messages.at(-1).author_kind, 'customer');
    assert.equal(reopened.json.ticket.assignee_id, undefined);
    assert.equal(JSON.stringify(reopened.json).includes(agent.user.email), false);
    assert.equal((await admin.call('/staff/queue?status=resolved')).json.tickets.length, 0);
  });
});

test('staff CLI grants and revokes real access and invalidates existing sessions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'garageshare-staff-test-'));
  const { client } = await setup(t, join(directory, 'garageshare.sqlite'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operator = await client().register('Operator');
  const cli = (...args) => execFileSync(process.execPath, ['server/admin.mjs', ...args], {
    env: { ...process.env, DATA_DIR: directory }, stdio: 'pipe'
  });
  cli('staff-grant', operator.user.email, 'admin');
  assert.equal((await operator.call('/session')).json.user, null);
  assert.equal((await operator.signIn()).staff_role, 'admin');
  assert.equal((await operator.call('/staff/queue')).status, 200);
  cli('staff-revoke', operator.user.email);
  assert.equal((await operator.call('/staff/queue')).status, 401);
  assert.equal((await operator.signIn()).staff_role, undefined);
  assert.equal((await operator.call('/staff/queue')).status, 403);
});

test('private chat follows the selected quote through booking and closes with the stay', async t => {
  const { db, client, garage } = await setup(t);
  const [guest, hostA, hostB, staff] = await Promise.all(['Guest', 'HostA', 'HostB', 'Staff'].map(name => client().register(name)));
  db.prepare("INSERT INTO staff_members VALUES (?,'admin')").run(staff.user.id);
  const a = await garage(hostA, 'Garage Alpha');
  const b = await garage(hostB, 'Garage Beta');
  const request = (await guest.call('/deals', { city: 'Nador', garage_ids: [a, b], mode: 'hourly', units: 3,
    starts_at: new Date(Date.now() + 3 * DAY).toISOString(), proposed_cents: 4500, request_key: id() })).json.request;
  const quoteA = request.quotes.find(q => q.garage_id === a);
  const quoteB = request.quotes.find(q => q.garage_id === b);
  const thread = q => `/chat/quote/${q.id}`;
  const text = { message: 'Will an SUV fit? <img src=x onerror=alert(1)>', request_key: id(), sender_id: hostA.user.id };
  let first, reservationId;
  await t.test('only a responding host and that renter can send or read messages', async () => {
    assert.equal((await guest.call(thread(quoteA))).json.conversation.writable, false);
    assert.equal((await guest.call(thread(quoteA) + '/send', text)).status, 409);
    assert.equal((await hostA.call(`/host/deals/${quoteA.id}/respond`, { action: 'match' })).status, 200);
    assert.equal((await hostB.call(`/host/deals/${quoteB.id}/respond`, { action: 'counter', total_cents: 4700 })).status, 200);
    assert.equal((await hostB.call(thread(quoteA))).status, 404);
    assert.equal((await staff.call(thread(quoteA))).status, 404);
    assert.equal((await staff.call(thread(quoteA) + '/read', { through: 1 })).status, 404);
    assert.equal((await client().call(thread(quoteA))).status, 401);
    assert.equal((await guest.call(thread(quoteA) + '/send', text, { 'X-CSRF-Token': 'forged' })).status, 403);
    const sent = await Promise.all([guest.call(thread(quoteA) + '/send', text), guest.call(thread(quoteA) + '/send', text)]);
    assert.deepEqual(sent.map(row => row.status), [200, 200]);
    first = sent[0].json.message;
    assert.equal(sent[1].json.message.seq, first.seq);
    assert.equal(first.own, true);
    const read = await hostA.call(thread(quoteA));
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal(read.json.messages.length, 1);
    assert.equal(read.json.messages[0].own, false);
    assert.equal(read.json.messages[0].message, text.message);
    assert.equal(JSON.stringify(read.json).includes(guest.user.email), false);
    assert.equal(JSON.stringify(read.json).includes('Private entrance'), false);
    assert.deepEqual((await staff.call('/chat')).json.conversations, []);
  });
  await t.test('unread counts, receipts and incremental replies belong to the intended conversation', async () => {
    assert.equal((await hostA.call('/chat')).json.conversations[0].unread, 1);
    assert.equal((await hostA.call(thread(quoteA) + '/read', { through: first.seq })).status, 200);
    assert.equal((await hostA.call('/chat')).json.conversations[0].unread, 0);
    assert.equal((await guest.call(thread(quoteA))).json.seen_through, first.seq);
    const reply = await hostA.call(thread(quoteA) + '/send', { message: 'Yes, an SUV fits.', request_key: id() });
    assert.equal(reply.status, 200);
    const next = await guest.call(thread(quoteA) + `?after=${first.seq}`);
    assert.deepEqual(next.json.messages.map(row => row.message), ['Yes, an SUV fits.']);
    assert.equal(next.json.messages[0].own, false);
    assert.equal((await guest.call(thread(quoteB))).json.messages.length, 0);
    assert.equal((await guest.call(thread(quoteB) + '/send', { message: 'How high is the entrance?', request_key: id() })).status, 200);
  });
  await t.test('the selected booking reuses chat history and the other quote becomes read-only', async () => {
    const selected = await guest.call(`/deals/${request.id}/select`, { quote_id: quoteA.id, total_cents: 4500 });
    assert.equal(selected.status, 200);
    reservationId = selected.json.reservation_id;
    const booking = `/chat/reservation/${reservationId}`;
    assert.equal((await hostB.call(booking)).status, 404);
    const previous = await guest.call(booking);
    assert.equal(previous.json.conversation.writable, true);
    assert.equal(previous.json.conversation.id, quoteA.id);
    assert.equal(previous.json.messages[0].seq, first.seq);
    const sent = await hostA.call(booking + '/send', { message: 'Please tell me when you arrive.', request_key: id() });
    assert.equal(sent.status, 200);
    assert.equal((await guest.call(thread(quoteA))).json.messages.length, 3);
    const closed = await hostB.call(thread(quoteB));
    assert.equal(closed.json.conversation.writable, false);
    assert.equal(closed.json.messages.length, 1);
    assert.equal((await hostB.call(thread(quoteB) + '/send', { message: 'Another reply', request_key: id() })).status, 409);
  });
  await t.test('cancelled stays retain history and reject new messages', async () => {
    assert.equal((await guest.call(`/reservations/${reservationId}/cancel`, {})).status, 200);
    const path = `/chat/reservation/${reservationId}`;
    assert.equal((await guest.call(path)).json.conversation.writable, false);
    assert.equal((await guest.call(path + '/send', { message: 'New message after cancellation', request_key: id() })).status, 409);
    assert.equal((await guest.call(path + '/send', text)).json.message.seq, first.seq);
    assert.equal((await guest.call(path + `?before=${first.seq}`)).json.messages.length, 0);
  });
  await t.test('a direct booking supports chat through the end of the stay', async () => {
    const booked = await guest.call('/reservations', { garage_id: a, mode: 'hourly', units: 1,
      starts_at: new Date(Date.now() + 8 * DAY).toISOString(), action: 'book', request_key: id() });
    assert.equal(booked.status, 201);
    const path = `/chat/reservation/${booked.json.reservation.id}`;
    const sent = await hostA.call(path + '/send', { message: 'Use the confirmed arrival details.', request_key: id() });
    assert.equal(sent.status, 200);
    assert.equal((await guest.call(path)).json.messages[0].message, 'Use the confirmed arrival details.');
    assert.equal((await hostB.call(path)).status, 404);
  });
});

test('host calendar blocks apply to search, direct bookings and quote acceptance', async t => {
  const { db, client, garage } = await setup(t);
  const [host, guest, other] = await Promise.all(['Host', 'Guest', 'Other'].map(name => client().register(name)));
  const a = await garage(host, 'Calendar garage');
  const b = await garage(other, 'Available garage');
  const start = Date.now() + 10 * DAY, end = start + 2 * 3600000;
  const iso = value => new Date(value).toISOString();
  const calendar = `/host/calendar/${a}`;
  const range = '?'+new URLSearchParams({ from: iso(start - DAY), to: iso(end + DAY) });
  const period = { starts_at: iso(start), mode: 'hourly', units: 2 };
  const search = data => '/garages?'+new URLSearchParams({ city: 'Nador', ...data });
  const block = { starts_at: iso(start), ends_at: iso(end), note: 'Private workshop visit', request_key: id() };
  const request = (await guest.call('/deals', { ...period, city: 'Nador', garage_ids: [a], proposed_cents: 3600, request_key: id() })).json.request;
  const quote = request.quotes[0];
  assert.equal((await host.call(`/host/deals/${quote.id}/respond`, { action: 'match' })).status, 200);
  let blockId;
  await t.test('only the owner can add or read a block, and retries reuse the same block', async () => {
    assert.equal((await guest.call(calendar + range)).status, 404);
    assert.equal((await other.call(calendar + '/blocks', block)).status, 404);
    assert.equal((await host.call(calendar + '/blocks', block, { 'X-CSRF-Token': 'forged' })).status, 403);
    assert.equal((await host.call(calendar + '/blocks', { ...block, ends_at: iso(start + 60000) })).status, 422);
    const saved = await host.call(calendar + '/blocks', block);
    assert.equal(saved.status, 200);
    blockId = saved.json.id;
    assert.equal((await host.call(calendar + '/blocks', block)).json.id, blockId);
    const agenda = (await host.call(calendar + range)).json;
    assert.equal(agenda.blocks.length, 1);
    assert.equal(agenda.blocks[0].note, block.note);
  });
  await t.test('hourly and monthly searches hide blocked garages without exposing the reason', async () => {
    for (const input of [period, { ...period, mode: 'monthly', units: 1 }]) {
      const result = await guest.call(search(input));
      assert.equal(result.status, 200);
      assert.deepEqual(result.json.garages.map(row => row.id), [b]);
      assert.equal(JSON.stringify(result.json).includes(block.note), false);
    }
    assert.equal((await guest.call(search({ ...period, units: 0 }))).status, 422);
    assert.equal((await guest.call('/reservations', { ...period, garage_id: a, action: 'book', request_key: id() })).status, 409);
    assert.equal((await guest.call(`/deals/${request.id}/select`, { quote_id: quote.id, total_cents: 3600 })).status, 409);
    assert.equal((await guest.call('/deals')).json.requests[0].quotes[0].available, 0);
    assert.throws(() => db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id(), a, guest.user.id, 'hourly', start, end, 2, 3600, 'confirmed', null, Date.now(), Date.now(), id()), /garage_block_conflict/);
  });
  await t.test('adjacent bookings work and a block cannot override a confirmed booking', async () => {
    const adjacent = await guest.call('/reservations', { ...period, starts_at: iso(end), garage_id: a, action: 'book', request_key: id() });
    assert.equal(adjacent.status, 201);
    assert.equal((await host.call(calendar + '/blocks', { ...block, starts_at: iso(end), ends_at: iso(end + 3600000), request_key: id() })).status, 409);
    const agenda = (await host.call(calendar + range)).json;
    assert.equal(agenda.bookings[0].id, adjacent.json.reservation.id);
    assert.equal(agenda.bookings[0].guest_id, undefined);
    assert.equal((await guest.call(calendar + `/blocks/${blockId}/remove`, {})).status, 404);
    assert.equal((await host.call(calendar + `/blocks/${blockId}/remove`, {})).status, 200);
    assert.equal((await guest.call(search(period))).json.garages.some(row => row.id === a), true);
    assert.equal((await guest.call(`/deals/${request.id}/select`, { quote_id: quote.id, total_cents: 3600 })).status, 200);
  });
});

test('completed booking reviews stay private until both submit or the deadline passes', async t => {
  const { db, client, garage } = await setup(t);
  const [host, guest, stranger] = await Promise.all(['Host', 'Guest', 'Stranger'].map(name => client().register(name)));
  const garageId = await garage(host, 'Review garage');
  const publicPath = `/garages/${garageId}/reviews`;
  async function booking(offset) {
    const result = await guest.call('/reservations', { garage_id: garageId, starts_at: new Date(Date.now() + offset * DAY).toISOString(),
      mode: 'hourly', units: 1, action: 'book', request_key: id() });
    assert.equal(result.status, 201);
    return result.json.reservation.id;
  }
  function finish(id, daysAgo) {
    const end = Date.now() - daysAgo * DAY;
    db.prepare('UPDATE reservations SET starts_at=?,ends_at=? WHERE id=?').run(end - 3600000, end, id);
  }
  const reservationId = await booking(3);
  const path = `/reviews/${reservationId}`;
  const rating = { rating: 5, comment: 'Easy arrival. <img src=x onerror=alert(1)>' };
  await t.test('only the two participants can review a completed stay', async () => {
    assert.equal((await guest.call(path, rating)).status, 409);
    assert.equal((await stranger.call(path)).status, 404);
    finish(reservationId, 1);
    assert.equal((await guest.call(path, { ...rating, rating: 6 })).status, 422);
    assert.equal((await stranger.call(path, rating)).status, 404);
    const submitted = await guest.call(path, { ...rating, role: 'host' });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.json.mine.role, 'renter');
    assert.equal(submitted.json.published, false);
    assert.equal((await host.call(path)).json.other, null);
    assert.deepEqual((await client().call(publicPath)).json.reviews, []);
  });
  await t.test('the second review publishes both and only renter feedback appears on the listing', async () => {
    const reply = await host.call(path, { rating: 4, comment: 'Host feedback stays in the trip.' });
    assert.equal(reply.status, 200);
    assert.equal(reply.json.published, true);
    assert.equal(reply.json.other.comment, rating.comment);
    const publicReviews = (await client().call(publicPath)).json.reviews;
    assert.equal(publicReviews.length, 1);
    assert.equal(publicReviews[0].comment, rating.comment);
    assert.equal(publicReviews[0].author_id, undefined);
    assert.equal(JSON.stringify(publicReviews).includes(reply.json.mine.comment), false);
    const listing = (await guest.call('/garages')).json.garages.find(row => row.id === garageId);
    assert.equal(listing.rating, 5);
    assert.equal(listing.review_count, 1);
    assert.equal((await guest.call(path, rating)).json.mine.rating, 5);
    assert.equal((await guest.call(path, { ...rating, rating: 1 })).status, 409);
  });
  await t.test('a single review becomes visible at the deadline and late submissions are rejected', async () => {
    const prior = await booking(5);
    finish(prior, 15);
    const row = db.prepare('SELECT ends_at FROM reservations WHERE id=?').get(prior);
    db.prepare('INSERT INTO stay_reviews VALUES (?,?,?,?,?,?,?)').run(prior, guest.user.id, 'renter', 3,
      'Earlier booking review.', row.ends_at + DAY, row.ends_at + 14 * DAY);
    assert.equal((await host.call(`/reviews/${prior}`)).json.other.rating, 3);
    assert.equal((await host.call(`/reviews/${prior}`, { rating: 5, comment: '' })).status, 409);
    const listing = (await guest.call('/garages')).json.garages.find(row => row.id === garageId);
    assert.equal(listing.rating, 4);
    assert.equal(listing.review_count, 2);
  });
});
