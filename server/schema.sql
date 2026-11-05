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
CREATE TABLE IF NOT EXISTS rate_limits (
 key TEXT PRIMARY KEY, hits INTEGER NOT NULL, resets_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, created_at INTEGER NOT NULL
);
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
