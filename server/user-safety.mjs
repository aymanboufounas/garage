import { ApiError, audit, limit, transaction } from './core.mjs';
import { accountState } from './account-lifecycle.mjs';

export const GUIDELINES_VERSION = '2026-11-18';
const recordId = /^[a-f0-9]{32}$/;
const interactionMessage = 'Interactions with this account are unavailable.';

export function hasBlock(db, firstId, secondId) {
  return Boolean(db.prepare(`SELECT 1 FROM user_blocks
    WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1`)
    .get(firstId, secondId, secondId, firstId));
}
export function requireInteractionAllowed(db, firstId, secondId) {
  if (hasBlock(db, firstId, secondId) || accountState(db, firstId) !== 'active' || accountState(db, secondId) !== 'active') {
    throw new ApiError(interactionMessage, 403);
  }
}
export function requireGuidelines(db, userId) {
  if (!db.prepare('SELECT 1 FROM user_guideline_acceptances WHERE user_id=? AND version=?').get(userId, GUIDELINES_VERSION)) {
    throw new ApiError('Accept the Community Guidelines before posting content.', 428);
  }
}

function blockedBy(db, userId, peerId) {
  return Boolean(db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=?').get(userId, peerId));
}

// A profile is reachable from a public listing or a relationship the caller can
// already see. Do not turn a guessed account ID into an account directory.
function knownPeer(db, userId, peerId) {
  if (typeof peerId !== 'string' || !recordId.test(peerId)) throw new ApiError('Account not found.', 404);
  const peer = db.prepare('SELECT id,name FROM users WHERE id=?').get(peerId);
  if (!peer) throw new ApiError('Account not found.', 404);
  const visible = peerId === userId || blockedBy(db, userId, peerId) ||
    db.prepare("SELECT 1 FROM garages WHERE owner_id=? AND status='approved' LIMIT 1").get(peerId) ||
    db.prepare(`SELECT 1 FROM reservations b JOIN garages g ON g.id=b.garage_id
      WHERE (b.guest_id=? AND g.owner_id=?) OR (b.guest_id=? AND g.owner_id=?) LIMIT 1`)
      .get(userId, peerId, peerId, userId) ||
    db.prepare(`SELECT 1 FROM rental_quotes q JOIN rental_requests r ON r.id=q.request_id
      JOIN garages g ON g.id=q.garage_id
      WHERE (r.guest_id=? AND g.owner_id=?) OR (r.guest_id=? AND g.owner_id=?) LIMIT 1`)
      .get(userId, peerId, peerId, userId) ||
    db.prepare(`SELECT 1 FROM chat_threads WHERE
      (guest_id=? AND host_id=?) OR (guest_id=? AND host_id=?) LIMIT 1`).get(userId, peerId, peerId, userId);
  if (!visible) throw new ApiError('Account not found.', 404);
  return peer;
}
function rejectActorOverride(data) {
  if (['actor_id', 'blocker_id', 'reporter_id', 'owner_id'].some(key => Object.hasOwn(data, key))) {
    throw new ApiError('The current account controls this action.', 403);
  }
}

export function safetyRoute(db, user, method, path, params, data = {}) {
  if (accountState(db, user.id) !== 'active') throw new ApiError(interactionMessage, 403);
  if (method === 'GET' && path === '/api/safety/guidelines') {
    const acceptance = db.prepare('SELECT version,accepted_at FROM user_guideline_acceptances WHERE user_id=?').get(user.id);
    return { version: GUIDELINES_VERSION, accepted: acceptance?.version === GUIDELINES_VERSION,
      accepted_at: acceptance?.version === GUIDELINES_VERSION ? acceptance.accepted_at : null };
  }
  if (method === 'POST' && path === '/api/safety/guidelines/accept') {
    rejectActorOverride(data);
    if (Object.hasOwn(data, 'user_id') || data.version !== GUIDELINES_VERSION || data.accepted !== true) {
      throw new ApiError('Confirm the current Community Guidelines.');
    }
    limit(db, `guidelines:${user.id}`, 20, 3600000);
    return transaction(db, () => {
      const previous = db.prepare('SELECT version,accepted_at FROM user_guideline_acceptances WHERE user_id=?').get(user.id);
      if (previous?.version === GUIDELINES_VERSION) return { version: GUIDELINES_VERSION, accepted: true, accepted_at: previous.accepted_at };
      const now = Date.now();
      db.prepare(`INSERT INTO user_guideline_acceptances(user_id,version,accepted_at) VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,accepted_at=excluded.accepted_at`).run(user.id, GUIDELINES_VERSION, now);
      audit(db, user.id, 'community_guidelines_accepted', GUIDELINES_VERSION);
      return { version: GUIDELINES_VERSION, accepted: true, accepted_at: now };
    });
  }
  if (method === 'GET' && path === '/api/safety/blocks') {
    const blocked_users = db.prepare(`SELECT u.id,u.name,b.created_at FROM user_blocks b
      JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC,u.id`).all(user.id);
    return { blocked_users };
  }
  if (method === 'POST' && path === '/api/safety/blocks') {
    rejectActorOverride(data);
    const peer = knownPeer(db, user.id, data.user_id);
    if (peer.id === user.id) throw new ApiError('You cannot block your own account.');
    limit(db, `block:${user.id}`, 30, 3600000);
    return transaction(db, () => {
      const saved = db.prepare('INSERT INTO user_blocks(blocker_id,blocked_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING')
        .run(user.id, peer.id, Date.now());
      if (saved.changes) audit(db, user.id, 'user_blocked', peer.id);
      return { blocked: true, user: { id: peer.id, name: peer.name } };
    });
  }
  const removal = path.match(/^\/api\/safety\/blocks\/([a-f0-9]{32})\/remove$/);
  if (method === 'POST' && removal) {
    rejectActorOverride(data);
    if (Object.hasOwn(data, 'user_id') && data.user_id !== removal[1]) throw new ApiError('The current account controls this action.', 403);
    limit(db, `block:${user.id}`, 30, 3600000);
    return transaction(db, () => {
      const removed = db.prepare('DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?').run(user.id, removal[1]);
      if (removed.changes) audit(db, user.id, 'user_unblocked', removal[1]);
      return { blocked: false };
    });
  }
  const profile = path.match(/^\/api\/safety\/profile\/([a-f0-9]{32})$/);
  if (method === 'GET' && profile) {
    const peer = knownPeer(db, user.id, profile[1]);
    return { user: { ...peer, blocked_by_you: blockedBy(db, user.id, peer.id),
      interaction_blocked: hasBlock(db, user.id, peer.id) || accountState(db, peer.id) !== 'active' } };
  }
  throw new ApiError('Endpoint not found.', 404);
}
