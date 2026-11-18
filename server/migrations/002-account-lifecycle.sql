-- Additive account state: existing users, sessions and positional inserts stay intact.
CREATE TABLE IF NOT EXISTS user_account_state (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('active','suspended','deleted')),
 reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_deletion_events (
 id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), completed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_photo_cleanup (
 image TEXT PRIMARY KEY, requested_at INTEGER NOT NULL,
 last_attempt INTEGER, attempts INTEGER NOT NULL DEFAULT 0
);
-- Track attribution across photo replacements, not just the current image URL.
CREATE TABLE IF NOT EXISTS listing_photo_owners (
 image TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listing_photo_owner_account ON listing_photo_owners(user_id);
-- Existing current photos can be attributed only when all references agree on one owner.
INSERT OR IGNORE INTO listing_photo_owners(image,user_id,created_at)
 SELECT image,min(owner_id),CAST(strftime('%s','now') AS INTEGER)*1000 FROM garages
 WHERE length(image)=length('/assets/host-photos/')+37
 AND substr(image,1,length('/assets/host-photos/'))='/assets/host-photos/'
 AND substr(image,length('/assets/host-photos/')+1,32) NOT GLOB '*[^0-9a-f]*'
 AND substr(image,-5)='.webp'
 GROUP BY image HAVING count(DISTINCT owner_id)=1;
