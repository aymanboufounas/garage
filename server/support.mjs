import { ApiError, audit, checkedRequestKey, id, limit, text, transaction } from './core.mjs';

const HOUR = 3600000;
const recordId = /^[a-f0-9]{32}$/;
const statuses = ['open', 'waiting', 'resolved'];
const categories = ['booking', 'listing', 'account', 'other'];

export function staffRole(db, userId) {
  return db.prepare('SELECT role FROM staff_members WHERE user_id=?').get(userId)?.role;
}

function findTicket(db, ticketId, userId, role) {
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(ticketId);
  if (!ticket || (!role && ticket.customer_id !== userId)) throw new ApiError('Support ticket not found.', 404);
  return ticket;
}

function ticketView(db, ticket, role) {
  const { request_key, customer_id, assignee_id, ...view } = ticket;
  view.messages = db.prepare(`
    SELECT id,author_kind,message,created_at FROM support_messages
    WHERE ticket_id=? ORDER BY created_at,rowid
  `).all(ticket.id);
  if (ticket.reservation_id) {
    view.reservation = db.prepare(`
      SELECT r.id,r.mode,r.units,r.status,r.starts_at,r.ends_at,r.total_cents,g.name,g.city
      FROM reservations r JOIN garages g ON g.id=r.garage_id WHERE r.id=?
    `).get(ticket.reservation_id);
  }
  if (role) {
    view.customer = db.prepare('SELECT name,email FROM users WHERE id=?').get(customer_id);
    view.assignee_id = assignee_id;
  }
  return view;
}

function addMessage(db, ticketId, authorId, kind, message, key, at) {
  db.prepare(`
    INSERT INTO support_messages (id,ticket_id,author_id,author_kind,message,created_at,request_key)
    VALUES (?,?,?,?,?,?,?)
  `).run(id(), ticketId, authorId, kind, message, at, key);
}

function createTicket(db, userId, data) {
  const key = checkedRequestKey(data);
  limit(db, `support-create:${userId}`, 8, HOUR);
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM support_tickets WHERE customer_id=? AND request_key=?').get(userId, key);
    if (previous) return ticketView(db, previous);
    if (!categories.includes(data.category)) throw new ApiError('Choose a support topic.');
    const subject = text(data, 'subject', 4, 120);
    const message = text(data, 'message', 5, 3000);
    const reservationId = data.reservation_id ?? null;
    if (reservationId !== null) {
      const ownsBooking = typeof reservationId === 'string' && recordId.test(reservationId) && db.prepare(`
        SELECT r.id FROM reservations r JOIN garages g ON g.id=r.garage_id
        WHERE r.id=? AND (r.guest_id=? OR g.owner_id=?)
      `).get(reservationId, userId, userId);
      if (!ownsBooking) throw new ApiError('Reservation not found.', 404);
    }
    const ticketId = id();
    const now = Date.now();
    db.prepare(`
      INSERT INTO support_tickets (id,customer_id,reservation_id,category,subject,status,created_at,updated_at,request_key)
      VALUES (?,?,?,?,?,'open',?,?,?)
    `).run(ticketId, userId, reservationId, data.category, subject, now, now, key);
    addMessage(db, ticketId, userId, 'customer', message, key, now);
    audit(db, userId, 'support_ticket_created', ticketId);
    return ticketView(db, findTicket(db, ticketId, userId));
  });
}

function assertCurrent(ticket, data) {
  if (ticket.updated_at !== data.updated_at) throw new ApiError('This ticket changed. Refresh it before updating.', 409);
}

function replyToTicket(db, userId, role, ticketId, data) {
  const key = checkedRequestKey(data);
  const message = text(data, 'message', 5, 3000);
  limit(db, `support-reply:${userId}`, 90, HOUR);
  return transaction(db, () => {
    const ticket = findTicket(db, ticketId, userId, role);
    const previous = db.prepare('SELECT id FROM support_messages WHERE ticket_id=? AND author_id=? AND request_key=?').get(ticketId, userId, key);
    if (previous) return ticketView(db, ticket, role);
    if (role) assertCurrent(ticket, data);
    const count = db.prepare('SELECT count(*) AS count FROM support_messages WHERE ticket_id=?').get(ticketId);
    if (count.count >= 200) throw new ApiError('This conversation is full. Open a new ticket.', 409);
    const now = Math.max(Date.now(), ticket.updated_at + 1);
    addMessage(db, ticketId, userId, role ? 'staff' : 'customer', message, key, now);
    const status = role ? 'waiting' : 'open';
    const assignee = ticket.assignee_id ?? (role ? userId : null);
    db.prepare('UPDATE support_tickets SET status=?,assignee_id=?,updated_at=? WHERE id=?').run(status, assignee, now, ticketId);
    audit(db, userId, role ? 'support_staff_replied' : 'support_customer_replied', ticketId);
    return ticketView(db, findTicket(db, ticketId, userId, role), role);
  });
}

function updateTicket(db, userId, role, ticketId, data) {
  return transaction(db, () => {
    const ticket = findTicket(db, ticketId, userId, role);
    assertCurrent(ticket, data);
    if (!statuses.includes(data.status)) throw new ApiError('Choose a support status.');
    const assignee = Object.hasOwn(data, 'assignee_id') ? data.assignee_id : ticket.assignee_id;
    if (assignee !== ticket.assignee_id && role !== 'admin' &&
        ((ticket.assignee_id !== null && ticket.assignee_id !== userId) || (assignee !== null && assignee !== userId))) {
      throw new ApiError('Only an administrator can reassign this ticket.', 403);
    }
    if (assignee !== null && (typeof assignee !== 'string' || !recordId.test(assignee) || !staffRole(db, assignee))) {
      throw new ApiError('Choose a staff member.');
    }
    const now = Math.max(Date.now(), ticket.updated_at + 1);
    db.prepare('UPDATE support_tickets SET status=?,assignee_id=?,updated_at=? WHERE id=?').run(data.status, assignee, now, ticketId);
    audit(db, userId, 'support_ticket_updated', ticketId);
    return ticketView(db, findTicket(db, ticketId, userId, role), role);
  });
}

function staffQueue(db, user, role, params) {
  const status = params.get('status') || 'all';
  const query = (params.get('q') || '').trim();
  const mine = params.get('mine') === '1';
  if (status !== 'all' && !statuses.includes(status)) throw new ApiError('Choose a support status.');
  if (query.length > 120) throw new ApiError('Search text is too long.');
  const tickets = db.prepare(`
    SELECT t.id,t.subject,t.category,t.status,t.reservation_id,t.updated_at,
           u.name AS customer_name,a.name AS assignee_name
    FROM support_tickets t JOIN users u ON u.id=t.customer_id
    LEFT JOIN users a ON a.id=t.assignee_id
    WHERE (?='all' OR t.status=?) AND (?=0 OR t.assignee_id=?)
    AND (?='' OR instr(lower(t.subject),lower(?))>0 OR instr(lower(u.name),lower(?))>0
      OR instr(lower(u.email),lower(?))>0 OR instr(t.id,?)>0 OR instr(t.reservation_id,?)>0)
    ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,t.updated_at DESC
    LIMIT 101
  `).all(status, status, mine ? 1 : 0, user.id, query, query, query, query, query, query);
  const counts = Object.fromEntries(db.prepare('SELECT status,count(*) AS total FROM support_tickets GROUP BY status').all().map(row => [row.status, row.total]));
  const staff = db.prepare('SELECT u.id,u.name FROM staff_members s JOIN users u ON u.id=s.user_id ORDER BY u.name').all();
  return { tickets: tickets.slice(0, 100), has_more: tickets.length > 100, counts, staff, role, actor_id: user.id };
}

export function supportRoute(db, user, method, path, params, data) {
  const staff = path.startsWith('/api/staff/');
  const role = staff ? staffRole(db, user.id) : undefined;
  if (staff && !role) throw new ApiError('Staff access is required.', 403);
  if (method === 'GET' && path === '/api/staff/queue') return staffQueue(db, user, role, params);
  if (method === 'GET' && path === '/api/support/tickets') {
    const tickets = db.prepare(`
      SELECT id,subject,category,status,reservation_id,created_at,updated_at
      FROM support_tickets WHERE customer_id=? ORDER BY updated_at DESC LIMIT 80
    `).all(user.id);
    return { tickets };
  }
  if (method === 'POST' && path === '/api/support/tickets') return { ticket: createTicket(db, user.id, data) };
  const match = path.match(/^\/api\/(support|staff)\/tickets\/([a-f0-9]{32})(?:\/(reply|update))?$/);
  if (match) {
    const [, , ticketId, action] = match;
    if (method === 'GET' && !action) return { ticket: ticketView(db, findTicket(db, ticketId, user.id, role), role) };
    if (method === 'POST' && action === 'reply') return { ticket: replyToTicket(db, user.id, role, ticketId, data) };
    if (method === 'POST' && action === 'update' && role) return { ticket: updateTicket(db, user.id, role, ticketId, data) };
  }
  throw new ApiError('Endpoint not found.', 404);
}
