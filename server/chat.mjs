import { ApiError, checkedRequestKey, id, integer, limit, text, transaction } from './core.mjs';
import { quoteChatOpen, reservationChatOpen } from '../web/chat-policy.js';

const PAGE_SIZE = 60;

function quoteContext(db, userId, quoteId) {
  const row = db.prepare(`
    SELECT q.id,q.status AS quote_status,r.status AS request_status,r.guest_id,
           r.starts_at,r.expires_at,g.owner_id AS host_id,g.name,g.status AS garage_status,
           b.id AS booking_id,b.status AS booking_status,b.ends_at
    FROM rental_quotes q JOIN rental_requests r ON r.id=q.request_id
    JOIN garages g ON g.id=q.garage_id
    LEFT JOIN reservations b ON b.id=r.reservation_id AND b.garage_id=q.garage_id
    WHERE q.id=? AND (r.guest_id=? OR g.owner_id=?)
  `).get(quoteId, userId, userId);
  if (!row) throw new ApiError('Conversation not found.', 404);
  const booking = row.booking_id ? { status: row.booking_status, ends_at: row.ends_at } : null;
  const request = { status: row.request_status, starts_at: row.starts_at, expires_at: row.expires_at };
  return {
    kind: 'quote', id: row.id, guest_id: row.guest_id, host_id: row.host_id, name: row.name,
    writable: Boolean(booking || row.garage_status === 'approved') &&
      quoteChatOpen({ status: row.quote_status }, request, booking)
  };
}

function getContext(db, userId, kind, contextId) {
  if (kind === 'quote') return quoteContext(db, userId, contextId);
  const row = db.prepare(`
    SELECT b.id,b.guest_id,b.status,b.starts_at,b.ends_at,b.expires_at,
           g.owner_id AS host_id,g.name,g.status AS garage_status,q.id AS quote_id
    FROM reservations b JOIN garages g ON g.id=b.garage_id
    LEFT JOIN rental_requests r ON r.reservation_id=b.id
    LEFT JOIN rental_quotes q ON q.request_id=r.id AND q.garage_id=b.garage_id
    WHERE b.id=? AND (b.guest_id=? OR g.owner_id=?)
  `).get(contextId, userId, userId);
  if (!row) throw new ApiError('Conversation not found.', 404);
  if (row.quote_id) return quoteContext(db, userId, row.quote_id);
  return {
    kind: 'reservation', id: row.id, guest_id: row.guest_id, host_id: row.host_id, name: row.name,
    writable: (row.status === 'confirmed' || row.garage_status === 'approved') && reservationChatOpen(row)
  };
}

function getThread(db, context) {
  const thread = context.kind === 'quote'
    ? db.prepare('SELECT * FROM chat_threads WHERE quote_id=?').get(context.id)
    : db.prepare('SELECT * FROM chat_threads WHERE reservation_id=?').get(context.id);
  if (thread && (thread.guest_id !== context.guest_id || thread.host_id !== context.host_id)) {
    throw new ApiError('Conversation not found.', 404);
  }
  return thread;
}

function summary(db, userId, context) {
  const host = context.host_id === userId;
  const peer = db.prepare('SELECT name FROM users WHERE id=?').get(host ? context.guest_id : context.host_id);
  return { kind: context.kind, id: context.id, garage_name: context.name,
    peer_name: peer.name, role: host ? 'host' : 'renter', writable: context.writable };
}

function messageView(row, userId) {
  return { seq: row.seq, own: row.sender_id === userId, message: row.message,
    created_at: row.created_at, read_at: row.read_at };
}

function cursor(value) {
  if (value === null) return 0;
  if (!/^\d{1,16}$/.test(value)) throw new ApiError('Choose a valid message reference.');
  return integer(Number(value), 1, Number.MAX_SAFE_INTEGER, 'message reference');
}

function readConversation(db, userId, context, thread, params) {
  const before = cursor(params.get('before'));
  const after = cursor(params.get('after'));
  if (before && after) throw new ApiError('Choose a valid message reference.');
  const conversation = summary(db, userId, context);
  if (!thread) return { conversation, messages: [], has_older: false, seen_through: 0 };
  const rows = after
    ? db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?').all(thread.id, after, PAGE_SIZE)
    : db.prepare(`
        SELECT * FROM chat_messages WHERE thread_id=? AND (?=0 OR seq<?) ORDER BY seq DESC LIMIT ?
      `).all(thread.id, before, before, PAGE_SIZE + 1);
  const messages = rows.slice(0, PAGE_SIZE).map(row => messageView(row, userId));
  if (!after) messages.reverse();
  const seen = db.prepare(`
    SELECT COALESCE(max(seq),0) AS seq FROM chat_messages WHERE thread_id=? AND sender_id=? AND read_at IS NOT NULL
  `).get(thread.id, userId);
  return { conversation, messages, has_older: !after && rows.length > PAGE_SIZE, seen_through: seen.seq };
}

function listConversations(db, userId) {
  const rows = db.prepare(`
    SELECT * FROM chat_threads WHERE guest_id=? OR host_id=? ORDER BY updated_at DESC LIMIT 80
  `).all(userId, userId);
  const conversations = [];
  for (const row of rows) {
    let context;
    try {
      context = getContext(db, userId, row.quote_id ? 'quote' : 'reservation', row.quote_id || row.reservation_id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) continue;
      throw error;
    }
    if (row.guest_id !== context.guest_id || row.host_id !== context.host_id) continue;
    const latest = db.prepare('SELECT * FROM chat_messages WHERE thread_id=? ORDER BY seq DESC LIMIT 1').get(row.id);
    const unread = db.prepare(`
      SELECT count(*) AS count FROM chat_messages WHERE thread_id=? AND sender_id<>? AND read_at IS NULL
    `).get(row.id, userId);
    conversations.push({ ...summary(db, userId, context), unread: unread.count,
      latest: latest ? messageView(latest, userId) : null });
  }
  return { conversations };
}

function sendMessage(db, userId, kind, contextId, data) {
  const key = checkedRequestKey(data);
  const message = text(data, 'message', 1, 2000);
  limit(db, `chat-send:${userId}`, 60, 10 * 60000);
  return transaction(db, () => {
    const context = getContext(db, userId, kind, contextId);
    let thread = getThread(db, context);
    if (thread) {
      const previous = db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND sender_id=? AND request_key=?').get(thread.id, userId, key);
      if (previous) return { message: messageView(previous, userId) };
    }
    if (!context.writable) throw new ApiError('This conversation is read-only.', 409);
    const now = Date.now();
    if (!thread) {
      thread = { id: id() };
      db.prepare(`
        INSERT INTO chat_threads (id,guest_id,host_id,reservation_id,quote_id,updated_at) VALUES (?,?,?,?,?,?)
      `).run(thread.id, context.guest_id, context.host_id,
        context.kind === 'reservation' ? context.id : null, context.kind === 'quote' ? context.id : null, now);
    }
    const saved = db.prepare(`
      INSERT INTO chat_messages (thread_id,sender_id,message,created_at,request_key) VALUES (?,?,?,?,?)
    `).run(thread.id, userId, message, now, key);
    db.prepare('UPDATE chat_threads SET updated_at=? WHERE id=?').run(now, thread.id);
    return { message: { seq: Number(saved.lastInsertRowid), own: true, message, created_at: now, read_at: null } };
  });
}

export function chatRoute(db, userId, method, path, params, data) {
  if (method === 'GET' && path === '/api/chat') return listConversations(db, userId);
  const match = path.match(/^\/api\/chat\/(reservation|quote)\/([a-f0-9]{32})(?:\/(send|read))?$/);
  if (!match) throw new ApiError('Endpoint not found.', 404);
  const [, kind, contextId, action] = match;
  if (method === 'POST' && action === 'send') return sendMessage(db, userId, kind, contextId, data);
  const context = getContext(db, userId, kind, contextId);
  const thread = getThread(db, context);
  if (method === 'GET' && !action) return readConversation(db, userId, context, thread, params);
  if (method === 'POST' && action === 'read') {
    const through = integer(data.through, 1, Number.MAX_SAFE_INTEGER, 'message reference');
    if (thread) {
      db.prepare(`
        UPDATE chat_messages SET read_at=? WHERE thread_id=? AND sender_id<>? AND read_at IS NULL AND seq<=?
      `).run(Date.now(), thread.id, userId, through);
    }
    return { ok: true };
  }
  throw new ApiError('Endpoint not found.', 404);
}
