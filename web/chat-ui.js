import { dateLabel, esc, icon } from './icons.js';
import { t } from './i18n.js';

const h = (key, params) => esc(t(key, params));
const content = row => row.sample ? t(row.sample === 'host' ? 'chatSampleHost' : 'chatSampleRenter') : row.message;

export function chatButton(kind, id, role) {
  return `<button class="secondary chat-button" data-action="chat-open" data-kind="${esc(kind)}" data-id="${esc(id)}">
    ${icon('chat')}${h(role === 'host' ? 'chatMessageRenter' : 'chatMessageHost')}</button>`;
}

export function chatInbox(conversations) {
  if (!conversations.length) return `<p class="small">${h('chatEmptyInbox')}</p>`;
  return `<div class="ticket-list">${conversations.map(row => `<button class="ticket-row" data-action="chat-open"
      data-kind="${esc(row.kind)}" data-id="${esc(row.id)}">
      <span><strong>${esc(row.peer_name)} · ${esc(row.garage_name)}</strong>
      ${row.latest ? `<small class="chat-preview-line">${esc(content(row.latest))}</small>` : ''}</span>
      ${row.unread ? `<span class="service-badge chat-unread">${h('chatUnread', { count: row.unread })}</span>` : ''}
    </button>`).join('')}</div>`;
}

export function chatMessages(messages, seenThrough, peer) {
  if (!messages.length) return `<p class="small">${h('chatEmpty')}</p>`;
  return messages.map(row => `<div class="chat-message ${row.own ? 'own' : ''}" data-seq="${esc(row.seq)}">
    <strong>${row.own ? h('chatYou') : esc(peer)}</strong><p>${esc(content(row))}</p>
    <small><bdi>${esc(dateLabel(row.created_at))}</bdi>${row.own ? ` · ${h(row.seq <= seenThrough ? 'chatSeen' : 'chatSent')}` : ''}</small>
  </div>`).join('');
}

export function chatSheet(result, demo) {
  const { conversation, messages, has_older, seen_through } = result;
  const prompts = conversation.role === 'host' ? ['chatAskTime', 'chatAskVehicle'] : ['chatAskSize', 'chatAskArrival'];
  return `<div class="sheet-content chat-content">
    <div class="eyebrow">${h('chatPrivate')}</div>
    <h2 id="sheet-title">${esc(conversation.peer_name)}</h2><p class="small">${esc(conversation.garage_name)}</p>
    ${demo ? `<p class="small">${h('chatPreview')}</p>` : ''}
    <div class="service-heading chat-tools">
      <button class="text-button" data-action="chat-refresh">${h('chatRefresh')}</button>
      <button class="text-button" data-action="chat-older" ${has_older ? '' : 'hidden'}>${h('chatLoadOlder')}</button>
    </div>
    <p id="chat-sync" class="small" role="status" hidden></p>
    <div class="chat-messages" id="chat-messages" role="log" aria-label="${h('chatInbox')}" tabindex="0">
      ${chatMessages(messages, seen_through, conversation.peer_name)}</div>
    <p id="chat-closed" class="notice" ${conversation.writable ? 'hidden' : ''}>${h('chatReadOnly')}</p>
    <div id="chat-compose" ${conversation.writable ? '' : 'hidden'}>
      <div class="chat-quick">${prompts.map(prompt => `<button type="button" class="chip" data-action="chat-prompt" data-prompt="${prompt}">${h(prompt)}</button>`).join('')}</div>
      <form class="form chat-form" id="chat-form">
        <label class="field">${h('chatCompose')}<textarea name="message" rows="2" maxlength="2000" required></textarea></label>
        <div class="form-error" hidden></div><button class="primary" type="submit">${h('chatSend')}</button>
      </form>
      ${demo ? `<button class="text-button" data-action="chat-sample">${h('chatSample')}</button>` : ''}
    </div>
  </div>`;
}
