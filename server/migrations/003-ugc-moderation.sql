CREATE TABLE IF NOT EXISTS ugc_reports (
 id TEXT PRIMARY KEY,
 reporter_id TEXT NOT NULL REFERENCES users(id),
 target_type TEXT NOT NULL CHECK(target_type IN ('user','garage','message','review')),
 target_id TEXT NOT NULL,
 subject_user_id TEXT NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL CHECK(reason IN ('spam','harassment','fraud','inappropriate','misleading','other')),
 explanation TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','under_review','resolved','dismissed')),
 evidence_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 reviewed_by TEXT REFERENCES users(id),
 review_note TEXT NOT NULL DEFAULT '',
 request_key TEXT NOT NULL,
 UNIQUE(reporter_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS ugc_reports_active_duplicate ON ugc_reports(reporter_id,target_type,target_id)
 WHERE status IN ('pending','under_review');
CREATE INDEX IF NOT EXISTS ugc_reports_queue ON ugc_reports(status,created_at);
CREATE INDEX IF NOT EXISTS ugc_reports_subject ON ugc_reports(subject_user_id,status);
CREATE TABLE IF NOT EXISTS content_moderation (
 target_type TEXT NOT NULL CHECK(target_type IN ('garage','message','review')),
 target_id TEXT NOT NULL,
 report_id TEXT NOT NULL REFERENCES ugc_reports(id),
 removed_by TEXT NOT NULL REFERENCES users(id),
 removed_at INTEGER NOT NULL,
 note TEXT NOT NULL,
 PRIMARY KEY(target_type,target_id)
);
CREATE TABLE IF NOT EXISTS ugc_notices (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 report_id TEXT NOT NULL REFERENCES ugc_reports(id),
 kind TEXT NOT NULL CHECK(kind IN ('warning','removed','suspended','restored')),
 message TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ugc_notices_owner ON ugc_notices(user_id,created_at);
