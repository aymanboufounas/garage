import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/app.mjs';
import { id, openDatabase } from '../server/core.mjs';

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
