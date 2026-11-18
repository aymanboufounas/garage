import { dateLabel, esc } from './icons.js';
import { t } from './i18n.js';

const h = (key, params) => esc(t(key, params));
const reasons = ['spam','harassment','fraud','inappropriate','misleading','other'];
const recordId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

export function guidelineAcceptance(version='2026-11-18') {
  return `<div class="safety-guideline-consent"><label class="safety-checkbox"><input type="checkbox" name="guidelines_accepted" value="1" required> <span>${h('safetyGuidelinesAccept')}</span></label>
    <a class="text-button" href="/community-guidelines" target="_blank" rel="noopener">${h('safetyGuidelinesRead')}</a>
    ${version ? `<input type="hidden" name="guidelines_version" value="${esc(version)}">` : ''}</div>`;
}

export function peerSafetyActions(peerId, blocked=false, demo=false) {
  if (demo) return `<p class="small safety-demo-note">${h('safetyDemoNotice')}</p>`;
  if (!recordId(peerId)) return '';
  return `<div class="safety-actions" role="group" aria-label="${h('safetyTitle')}">
    <button class="text-button" type="button" data-action="safety-profile" data-peer="${esc(peerId)}">${h('safetyProfile')}</button>
    <button class="text-button" type="button" data-action="${blocked?'safety-unblock':'safety-block'}" data-peer="${esc(peerId)}">${h(blocked?'safetyUnblock':'safetyBlock')}</button>
    <button class="text-button" type="button" data-action="safety-report" data-target-type="user" data-target-id="${esc(peerId)}">${h('safetyReportUser')}</button>
  </div>`;
}

export function reportSheet(target={}) {
  const type=target.type || target.target_type || 'user';
  const id=target.id ?? target.target_id ?? '';
  return `<div class="sheet-content safety-content"><div class="eyebrow">${h('safetyTitle')}</div><h2 id="sheet-title">${h('safetyReportTitle')}</h2>
    <p class="small">${h('safetyReportIntro')}</p>${target.label?`<p>${esc(target.label)}</p>`:''}
    ${target.demo?`<p class="notice">${h('safetyDemoNotice')}</p>`:''}
    <form id="safety-report-form" class="form" data-target-type="${esc(type)}" data-target-id="${esc(String(id))}">
      <label class="field">${h('safetyReportReason')}<select name="reason" required>${reasons.map(reason=>`<option value="${reason}">${h('safetyReason_'+reason)}</option>`).join('')}</select></label>
      <label class="field">${h('safetyReportDetails')}<textarea name="explanation" rows="4" maxlength="1000"></textarea><small>${h('safetyReportHint')}</small></label>
      <div class="form-error" hidden></div><button class="primary wide" type="submit" ${target.demo?'disabled':''}>${h('safetyReportSubmit')}</button>
    </form></div>`;
}

export function blockedUsersSheet(data=[]) {
  const users=Array.isArray(data)?data:(data.users || data.blocked_users || []);
  return `<div class="sheet-content safety-content"><h2 id="sheet-title">${h('safetyBlockedUsers')}</h2><p class="small">${h('safetyBlockInfo')}</p>
    <div class="safety-block-list">${users.length?users.map(user=>{
      const id=user.id || user.user_id || user.blocked_id;
      return `<article class="safety-block-row"><div><strong>${esc(user.name || user.user_name || t('safetyMember'))}</strong>${user.created_at?`<p class="small">${h('safetyBlockedSince',{date:dateLabel(user.created_at)})}</p>`:''}</div>
        <button class="secondary" type="button" data-action="safety-unblock" data-peer="${esc(id)}">${h('safetyUnblock')}</button></article>`;
    }).join(''):`<p class="small">${h('safetyNoBlocks')}</p>`}</div></div>`;
}

export function guidelinesSheet(config={}) {
  const version=config.guidelines_version || config.version || '';
  const accepted=config.accepted===true || (version && config.accepted_version===version);
  return `<div class="sheet-content safety-content"><h2 id="sheet-title">${h('safetyGuidelines')}</h2><p>${h('safetyGuidelinesIntro')}</p>
    ${version?`<p class="small">${h('safetyGuidelinesVersion',{version})}</p>`:''}
    <ul class="safety-guidelines">${['safetyGuidelineRespect','safetyGuidelineHonesty','safetyGuidelinePrivacy','safetyGuidelineEnforcement'].map(key=>`<li>${h(key)}</li>`).join('')}</ul>
    ${accepted?`<p class="notice">${h('safetyGuidelinesAccepted')}</p>`:`<form id="guidelines-form" class="form" data-version="${esc(version)}">${guidelineAcceptance(version)}<div class="form-error" hidden></div><button class="primary wide" type="submit">${h('safetyGuidelinesSave')}</button></form>`}
    <a class="text-button" href="/community-guidelines" target="_blank" rel="noopener">${h('safetyGuidelinesRead')}</a></div>`;
}

export function deletionSheet(status={}) {
  const pending=status.pending===true || ['pending','requested','scheduled'].includes(status.state || status.status);
  const blocked=status.can_delete===false || Number(status.active_reservations)>0;
  const lastAdmin=status.blockers?.some(row=>row.code==='last_administrator');
  return `<div class="sheet-content safety-content"><h2 id="sheet-title">${h('safetyDeleteAccount')}</h2><p>${h('safetyDeleteIntro')}</p>
    ${status.retention==='pseudonymous_history'?`<p class="small">${h('safetyDeleteRetention')}</p>`:''}
    ${status.requires_recent_sign_in?`<p class="small">${h('safetyDeleteRecent')}</p>`:''}
    <a class="text-button" href="/privacy-policy" target="_blank" rel="noopener">${h('safetyDeletePrivacy')}</a>
    ${pending?`<section class="safety-deletion-status"><p class="notice">${h('safetyDeletePending')}</p>${status.requested_at?`<p class="small">${h('safetyDeleteRequested',{date:dateLabel(status.requested_at)})}</p>`:''}${status.can_cancel?`<button class="secondary wide" type="button" data-action="safety-delete-cancel">${h('safetyDeleteCancel')}</button>`:''}</section>`:
      `${blocked?`<p class="notice">${h(lastAdmin?'safetyDeleteLastAdmin':'safetyDeleteBlocked')}</p>`:''}<form id="account-deletion-form" class="form">
        <label class="field">${h('safetyDeletePhrase')}<input name="confirmation" autocomplete="off" pattern="DELETE" maxlength="6" required></label>
        ${status.requires_password?`<label class="field">${h('safetyDeletePassword')}<input name="password" type="password" autocomplete="current-password" required></label>`:''}
        <label class="safety-checkbox"><input name="confirmed" type="checkbox" value="1" required> <span>${h('safetyDeleteConfirm')}</span></label>
        <div class="form-error" hidden></div><button class="danger wide" type="submit" ${blocked?'disabled':''}>${h('safetyDeleteSubmit')}</button></form>`}</div>`;
}

export function userProfileSheet(user={}) {
  return `<div class="sheet-content safety-content"><div class="eyebrow">${h('safetyMember')}</div><h2 id="sheet-title">${esc(user.name || t('safetyMember'))}</h2>
    ${user.created_at?`<p class="small">${h('safetyMemberSince',{date:dateLabel(user.created_at)})}</p>`:''}
    ${user.blocked_by_you?`<p class="notice">${h('safetyBlocked')}</p>`:user.interaction_blocked?`<p class="notice">${h('safetyInteractionBlocked')}</p>`:''}
    <p class="small">${h('safetyBlockInfo')}</p>${peerSafetyActions(user.id || user.user_id,user.blocked_by_you,user.demo)}</div>`;
}

export function noticesSheet(data=[]) {
  const notices=Array.isArray(data)?data:(data.notices || []);
  return `<div class="sheet-content safety-content"><h2 id="sheet-title">${h('safetyNotices')}</h2>${notices.length?notices.map(notice=>`<article class="safety-notice"><h3>${esc(notice.title || t('safetyTitle'))}</h3><p>${['warning','removed','suspended','restored'].includes(notice.kind)?h('safetyNotice_'+notice.kind):esc(notice.message || notice.reason || '')}</p>${notice.created_at?`<p class="small">${esc(dateLabel(notice.created_at))}</p>`:''}</article>`).join(''):`<p class="small">${h('safetyNoNotices')}</p>`}</div>`;
}
