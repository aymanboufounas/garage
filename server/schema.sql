PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS google_identities (
 subject TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS google_attempts (
 launch_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL UNIQUE REFERENCES sessions(token_hash) ON DELETE CASCADE,
 channel TEXT NOT NULL CHECK(channel IN ('web','android')), language TEXT NOT NULL,
 expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','opened','verifying','ready')),
 state_hash TEXT UNIQUE, browser_hash TEXT, nonce TEXT, verifier TEXT, proof_hash TEXT UNIQUE, identity TEXT
);
CREATE INDEX IF NOT EXISTS google_attempt_expiry ON google_attempts(expires_at);
CREATE TABLE IF NOT EXISTS garages (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, city TEXT NOT NULL, area TEXT NOT NULL, address TEXT NOT NULL,
 latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90), longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 hourly_cents INTEGER NOT NULL CHECK(hourly_cents BETWEEN 100 AND 100000),
 monthly_cents INTEGER NOT NULL CHECK(monthly_cents BETWEEN 10000 AND 10000000),
 height_cm INTEGER NOT NULL CHECK(height_cm BETWEEN 140 AND 500),
 vehicle_size TEXT NOT NULL CHECK(vehicle_size IN ('compact','suv','van')),
 covered INTEGER NOT NULL DEFAULT 1 CHECK(covered IN (0,1)),
 description TEXT NOT NULL, image TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','archived')),
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
 id TEXT PRIMARY KEY, garage_id TEXT NOT NULL REFERENCES garages(id),
 guest_id TEXT NOT NULL REFERENCES users(id), mode TEXT NOT NULL CHECK(mode IN ('hourly','monthly')),
 starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
 units INTEGER NOT NULL CHECK(units>0), total_cents INTEGER NOT NULL CHECK(total_cents>0),
 status TEXT NOT NULL CHECK(status IN ('requested','countered','confirmed','declined','cancelled','expired')),
 expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 request_key TEXT NOT NULL, UNIQUE(guest_id,request_key)
);
CREATE INDEX IF NOT EXISTS reservation_availability ON reservations(garage_id,status,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS reservation_guest ON reservations(guest_id,created_at);
CREATE TABLE IF NOT EXISTS garage_blocks (
 id TEXT PRIMARY KEY, garage_id TEXT NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
 starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
 note TEXT NOT NULL, request_key TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(garage_id,request_key)
);
CREATE INDEX IF NOT EXISTS garage_blocks_range ON garage_blocks(garage_id,starts_at,ends_at);
CREATE TABLE IF NOT EXISTS stay_reviews (
 reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('renter','host')),
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT NOT NULL,
 created_at INTEGER NOT NULL, publish_at INTEGER NOT NULL CHECK(publish_at>=created_at),
 PRIMARY KEY(reservation_id,role)
);
CREATE INDEX IF NOT EXISTS stay_reviews_published ON stay_reviews(role,publish_at);
CREATE TABLE IF NOT EXISTS rate_limits (
 key TEXT PRIMARY KEY, hits INTEGER NOT NULL, resets_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rental_requests (
 id TEXT PRIMARY KEY, guest_id TEXT NOT NULL REFERENCES users(id),
 city TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('hourly','monthly')),
 starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
 units INTEGER NOT NULL CHECK(units>0), proposed_cents INTEGER NOT NULL CHECK(proposed_cents>0),
 status TEXT NOT NULL CHECK(status IN ('open','booked','cancelled','expired')),
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 reservation_id TEXT UNIQUE REFERENCES reservations(id),
 request_key TEXT NOT NULL, UNIQUE(guest_id,request_key),
 CHECK((status='booked')=(reservation_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS rental_requests_guest ON rental_requests(guest_id,created_at);
CREATE INDEX IF NOT EXISTS rental_requests_expiry ON rental_requests(status,expires_at);
CREATE TABLE IF NOT EXISTS rental_quotes (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES rental_requests(id) ON DELETE CASCADE,
 garage_id TEXT NOT NULL REFERENCES garages(id),
 status TEXT NOT NULL CHECK(status IN ('invited','quoted','declined')),
 total_cents INTEGER CHECK(total_cents>0),
 CHECK((status='quoted')=(total_cents IS NOT NULL)),
 UNIQUE(request_id,garage_id)
);
CREATE INDEX IF NOT EXISTS rental_quotes_garage ON rental_quotes(garage_id);
CREATE TABLE IF NOT EXISTS staff_members (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('admin','support'))
);
CREATE TABLE IF NOT EXISTS support_tickets (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES users(id),
 reservation_id TEXT REFERENCES reservations(id) ON DELETE SET NULL,
 category TEXT NOT NULL CHECK(category IN ('booking','listing','account','other')),
 subject TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','waiting','resolved')),
 assignee_id TEXT REFERENCES staff_members(user_id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 request_key TEXT NOT NULL, UNIQUE(customer_id,request_key)
);
CREATE INDEX IF NOT EXISTS support_tickets_queue ON support_tickets(status,updated_at);
CREATE INDEX IF NOT EXISTS support_tickets_customer ON support_tickets(customer_id,updated_at);
CREATE TABLE IF NOT EXISTS support_messages (
 id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id),
 author_kind TEXT NOT NULL CHECK(author_kind IN ('customer','staff')),
 message TEXT NOT NULL, created_at INTEGER NOT NULL, request_key TEXT NOT NULL,
 UNIQUE(ticket_id,author_id,request_key)
);
CREATE INDEX IF NOT EXISTS support_messages_thread ON support_messages(ticket_id,created_at);
CREATE TABLE IF NOT EXISTS chat_threads (
 id TEXT PRIMARY KEY,
 guest_id TEXT NOT NULL REFERENCES users(id), host_id TEXT NOT NULL REFERENCES users(id),
 reservation_id TEXT UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
 quote_id TEXT UNIQUE REFERENCES rental_quotes(id) ON DELETE CASCADE,
 updated_at INTEGER NOT NULL,
 CHECK(guest_id<>host_id), CHECK((reservation_id IS NULL)<>(quote_id IS NULL))
);
CREATE INDEX IF NOT EXISTS chat_threads_guest ON chat_threads(guest_id,updated_at);
CREATE INDEX IF NOT EXISTS chat_threads_host ON chat_threads(host_id,updated_at);
CREATE TABLE IF NOT EXISTS chat_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
 sender_id TEXT NOT NULL REFERENCES users(id),
 message TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
 request_key TEXT NOT NULL, UNIQUE(thread_id,sender_id,request_key)
);
CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(thread_id,seq);
-- A last line of defence against overlapping confirmed bookings, including direct writes.
CREATE TRIGGER IF NOT EXISTS no_overlap_insert BEFORE INSERT ON reservations
WHEN NEW.status='confirmed'
BEGIN
 SELECT RAISE(ABORT,'reservation_overlap') WHERE EXISTS (
  SELECT 1 FROM reservations WHERE garage_id=NEW.garage_id AND status='confirmed'
  AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at
 );
END;
CREATE TRIGGER IF NOT EXISTS no_overlap_update BEFORE UPDATE ON reservations
WHEN NEW.status='confirmed'
BEGIN
 SELECT RAISE(ABORT,'reservation_overlap') WHERE EXISTS (
  SELECT 1 FROM reservations WHERE garage_id=NEW.garage_id AND status='confirmed'
  AND id<>NEW.id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at
 );
END;
CREATE TRIGGER IF NOT EXISTS no_blocked_reservation_insert BEFORE INSERT ON reservations
WHEN NEW.status='confirmed' AND EXISTS (
 SELECT 1 FROM garage_blocks WHERE garage_id=NEW.garage_id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at
)
BEGIN
 SELECT RAISE(ABORT,'garage_block_conflict');
END;
CREATE TRIGGER IF NOT EXISTS no_blocked_reservation_update BEFORE UPDATE ON reservations
WHEN NEW.status='confirmed' AND EXISTS (
 SELECT 1 FROM garage_blocks WHERE garage_id=NEW.garage_id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at
)
BEGIN
 SELECT RAISE(ABORT,'garage_block_conflict');
END;
CREATE TRIGGER IF NOT EXISTS no_overlapping_block_insert BEFORE INSERT ON garage_blocks
WHEN EXISTS (
 SELECT 1 FROM reservations WHERE garage_id=NEW.garage_id AND status='confirmed' AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at
) OR EXISTS (
 SELECT 1 FROM garage_blocks WHERE garage_id=NEW.garage_id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at
)
BEGIN
 SELECT RAISE(ABORT,'garage_block_conflict');
END;
CREATE TRIGGER IF NOT EXISTS no_overlapping_block_update BEFORE UPDATE ON garage_blocks
WHEN EXISTS (
 SELECT 1 FROM reservations WHERE garage_id=NEW.garage_id AND status='confirmed' AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at
) OR EXISTS (
 SELECT 1 FROM garage_blocks WHERE id<>OLD.id AND garage_id=NEW.garage_id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at
)
BEGIN
 SELECT RAISE(ABORT,'garage_block_conflict');
END;
