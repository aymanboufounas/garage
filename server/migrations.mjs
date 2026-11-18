import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Additive, versioned migrations run after the original schema bootstrap. Applied
// migrations are immutable; an unexpected edit fails instead of altering history.
export function migrateDatabase(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const directory = new URL('./migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{3}-[a-z0-9-]+\.sql$/.test(name)).sort()) {
    const sql = readFileSync(new URL(name, directory), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT checksum FROM schema_migrations WHERE name=?').get(name);
      if (previous && previous.checksum !== checksum) throw new Error('An applied database migration has changed: ' + name);
      if (!previous) {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(name, checksum, Date.now());
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
