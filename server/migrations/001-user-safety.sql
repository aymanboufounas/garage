-- Additive safety controls; existing users, sessions and bookings are unchanged.
CREATE TABLE IF NOT EXISTS user_blocks (
 blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(blocker_id,blocked_id),
 CHECK(blocker_id<>blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_target ON user_blocks(blocked_id,blocker_id);
CREATE TABLE IF NOT EXISTS user_guideline_acceptances (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version TEXT NOT NULL,
 accepted_at INTEGER NOT NULL
);
