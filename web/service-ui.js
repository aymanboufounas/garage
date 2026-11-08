import { cityName, duration, localizedField, t } from './i18n.js';
import { dateLabel, esc, icon, money, moroccoInput } from './icons.js';
import { requestKey } from './data.js';
import { chatButton } from './chat-ui.js';

const h = (key, params) => esc(t(key, params));
const price = cents => `${money(cents)} ${t('currency')}`;
const note = (key, params) => `<p class="small">${h(key, params)}</p>`;
const timeframe = row => `${dateLabel(row.starts_at)} → ${dateLabel(row.ends_at)}`;
const kindStatus = (kind, status) => `<span class="service-badge ${esc(status)}">${h(`${kind}_status_${status}`)}</span>`;
const dealStatus = status => ['cancelled', 'expired'].includes(status)
  ? `<span class="service-badge ${esc(status)}">${h(`status_${status}`)}</span>` : kindStatus('deal', status);
export const ticketStatus = status => kindStatus('support', status);

export function priceRequestForm(garages, city, mode, period = null) {
  const now = Date.now();
  const start = period?.starts_at ?? Math.ceil((now + 3600000) / 3600000) * 3600000;
  const units = period?.units ?? (mode === 'hourly' ? 3 : 1);
  const rate = g => mode === 'hourly' ? g.hourly_cents : g.monthly_cents;
  return `<div class="sheet-content">
    <div class="eyebrow">${esc(cityName(city))} · ${h(mode)}</div>
    <h2 id="sheet-title">${h('dealFormTitle')}</h2>${note('dealFormCopy')}
    <form id="price-request-form" class="form">
      <input type="hidden" name="city" value="${esc(city)}">
      <input type="hidden" name="mode" value="${esc(mode)}">
      <input type="hidden" name="request_key" value="${requestKey()}">
      <div class="two-fields service-fields">
        <label class="field">${h('startMorocco')}
          <input type="datetime-local" name="start" value="${moroccoInput(start)}" min="${moroccoInput(now + 60000)}" required>
        </label>
        <label class="field">${h(mode === 'hourly' ? 'hours' : 'months')}
          <input type="number" name="units" value="${units}" min="1" max="${mode === 'hourly' ? 168 : 12}" required>
        </label>
      </div>
      <label class="field">${h('dealProposedTotal')}
        <input type="number" name="total" min="1" step="0.01" inputmode="decimal" value="${Math.round(rate(garages[0]) * units / 100)}" required>
      </label>
      <fieldset class="deal-choices"><legend>${h('dealChooseGarages')}</legend>
        ${garages.map((g, i) => `<label class="deal-choice"><input type="checkbox" name="garage_ids" value="${esc(g.id)}" ${i < 2 ? 'checked' : ''}>
          <span><strong>${esc(localizedField(g, 'name'))}</strong><small>${esc(g.area)}</small></span>
          <bdi>${esc(price(rate(g)))} / ${h(mode === 'hourly' ? 'hour' : 'month')}</bdi></label>`).join('')}
      </fieldset>
      <div class="form-error" hidden></div>
      <button class="primary wide" type="submit">${h('dealSend')} ${icon('arrow')}</button>
    </form>
  </div>`;
}

function guestQuote(quote, request) {
  const selected = request.selected_garage_id === quote.garage_id;
  const actionable = request.status === 'open' && quote.status === 'quoted' && quote.available;
  const status = selected ? h('dealChosen') : request.status !== 'open' ? h('deal_status_closed')
    : quote.status === 'quoted' && !quote.available ? h('dealUnavailable') : h(`deal_status_${quote.status}`);
  return `<li class="deal-quote">
    <div><strong>${esc(localizedField(quote, 'name'))}</strong>
      <p class="small">${esc(quote.area)} · ${esc(quote.owner_name)}</p>
      <p class="small">${h(quote.covered ? 'covered' : 'outdoor')} · ${h(quote.vehicle_size)}</p></div>
    <div class="deal-price">${quote.total_cents !== null ? `<strong><bdi>${esc(price(quote.total_cents))}</bdi></strong>` : ''}
      <small>${status}</small></div>
    ${quote.status === 'quoted' ? chatButton('quote', quote.id, 'renter') : ''}
    ${actionable ? `<button class="secondary" data-action="price-select" data-id="${esc(request.id)}"
      data-quote="${esc(quote.id)}">${h('dealChooseQuote')}</button>` : ''}
  </li>`;
}

export function guestPriceRequests(requests, demo) {
  return `<section id="price-requests" class="service-section" aria-label="${h('dealGuestTitle')}">
    <div class="service-heading"><h2>${h('dealGuestTitle')}</h2>
      <button class="text-button" data-action="refresh">${h('dealRefresh')}</button></div>
    ${requests.length ? requests.map(request => `<article class="service-card">
      <div class="service-heading"><strong>${esc(cityName(request.city))} · ${esc(duration(request.units, request.mode))}</strong>
        ${dealStatus(request.status)}</div>
      <p class="small"><bdi>${esc(timeframe(request))}</bdi></p>
      ${note('dealBudget', { total: price(request.proposed_cents) })}
      ${request.status === 'open' ? note('dealExpires', { date: dateLabel(request.expires_at) }) : ''}
      <ul class="deal-quotes">${request.quotes.map(q => guestQuote(q, request)).join('')}</ul>
      ${request.status === 'open' ? `<div class="service-actions">
        ${demo && request.quotes.some(q => q.status === 'invited') ? `<button class="secondary" data-action="price-sample-replies" data-id="${esc(request.id)}">${h('dealSampleReplies')}</button>` : ''}
        <button class="text-button" data-action="price-cancel" data-id="${esc(request.id)}">${h('dealCancel')}</button>
      </div>` : ''}
    </article>`).join('') : note('dealGuestEmpty')}
  </section>`;
}

export function hostPriceRequests(quotes, demo) {
  return `<section class="service-section" aria-label="${h('dealHostTitle')}">
    <div class="service-heading"><h2>${h('dealHostTitle')}</h2>
      <button class="text-button" data-action="refresh">${h('dealRefresh')}</button></div>
    ${demo ? `<button class="secondary" data-action="price-sample-invitation">${h('dealSampleInvite')}</button>` : ''}
    ${quotes.length ? quotes.map(q => {
      const active = q.request_status === 'open';
      const status = q.selected ? 'booked' : active ? q.status : 'closed';
      return `<article class="service-card">
        <div class="service-heading"><strong>${esc(localizedField(q, 'name'))}</strong>${dealStatus(status)}</div>
        <p class="small">${esc(localizedField(q, 'guest_name'))} · ${esc(duration(q.units, q.mode))}</p>
        <p class="small"><bdi>${esc(timeframe(q))}</bdi></p>
        ${note('dealBudget', { total: price(q.proposed_cents) })}
        ${q.total_cents !== null ? `<strong><bdi>${esc(price(q.total_cents))}</bdi></strong>` : ''}
        ${active ? note('dealExpires', { date: dateLabel(q.expires_at) }) : ''}
        ${q.status === 'quoted' ? `<div class="service-actions">${chatButton('quote', q.id, 'host')}</div>` : ''}
        ${active && q.status !== 'declined' ? `<div class="service-actions">
          ${q.status === 'invited' ? `<button class="primary" data-action="price-respond" data-id="${esc(q.id)}" data-response="match">${h('dealMatched')}</button>
            <button class="secondary" data-action="price-counter" data-id="${esc(q.id)}">${h('counterTitle')}</button>` : ''}
          <button class="secondary" data-action="price-respond" data-id="${esc(q.id)}" data-response="decline">${h(q.status === 'quoted' ? 'dealWithdraw' : 'decline')}</button>
        </div>` : ''}
      </article>`;
    }).join('') : note('dealHostEmpty')}
  </section>`;
}

export function selectPriceForm(request, quote) {
  return `<div class="sheet-content"><h2 id="sheet-title">${h('dealChooseQuote')}</h2>
    <strong>${esc(localizedField(quote, 'name'))}</strong><p class="small"><bdi>${esc(timeframe(request))}</bdi></p>
    ${note('dealConfirmCopy')}
    <form id="price-select-form" class="form" data-id="${esc(request.id)}">
      <input type="hidden" name="quote_id" value="${esc(quote.id)}">
      <input type="hidden" name="total_cents" value="${esc(quote.total_cents)}">
      <div class="form-error" hidden></div>
      <button class="primary wide" type="submit">${h('dealConfirm', { total: price(quote.total_cents) })}</button>
    </form></div>`;
}

export function counterPriceForm(quoteId) {
  return `<div class="sheet-content"><h2 id="sheet-title">${h('counterTitle')}</h2>
    <form id="price-counter-form" class="form" data-id="${esc(quoteId)}">
      <label class="field">${h('newTotal')}<input type="number" name="total" min="1" step="0.01" inputmode="decimal" required></label>
      <div class="form-error" hidden></div><button class="primary wide" type="submit">${h('sendCounter')}</button>
    </form></div>`;
}

export function supportList(tickets) {
  return tickets.length ? `<div class="ticket-list">${tickets.map(ticket => `<button class="ticket-row" data-action="support-ticket" data-id="${esc(ticket.id)}">
    <span><strong>${esc(ticket.subject)}</strong><small>${h(`support_category_${ticket.category}`)} · <bdi>${esc(dateLabel(ticket.updated_at))}</bdi></small></span>
    ${ticketStatus(ticket.status)}</button>`).join('')}</div>` : note('supportEmpty');
}

export function supportTicketForm(reservationId, demo) {
  return `<div class="sheet-content"><h2 id="sheet-title">${h('supportNew')}</h2>
    ${demo ? note('supportPreview') : ''}
    ${reservationId ? note('supportReference', { id: reservationId.slice(0, 8) }) : ''}
    <form class="form" id="support-create-form">
      <input type="hidden" name="request_key" value="${requestKey()}">
      ${reservationId ? `<input type="hidden" name="reservation_id" value="${esc(reservationId)}">` : ''}
      <label class="field">${h('supportTopic')}<select name="category">
        ${['booking', 'listing', 'account', 'other'].map(category => `<option value="${category}">${h(`support_category_${category}`)}</option>`).join('')}
      </select></label>
      <label class="field">${h('supportSubject')}<input name="subject" minlength="4" maxlength="120" required></label>
      <label class="field">${h('supportMessage')}<textarea name="message" minlength="5" maxlength="3000" required></textarea>
        <small>${h('supportMessageHint')}</small></label>
      <div class="form-error" hidden></div><button class="primary wide" type="submit">${h('supportSend')}</button>
    </form></div>`;
}

export function supportMessages(ticket) {
  const booking = ticket.reservation;
  const context = booking ? `<div class="support-booking">
    <strong>${h('supportReference', { id: booking.id.slice(0, 8) })} · ${esc(booking.name)}</strong>
    <p class="small">${esc(cityName(booking.city))} · ${h(`status_${booking.status}`)} · <bdi>${esc(price(booking.total_cents))}</bdi></p>
    <p class="small"><bdi>${esc(timeframe(booking))}</bdi></p>
  </div>` : '';
  return `${context}<ol class="support-thread">${ticket.messages.map(message => `<li class="support-message ${message.author_kind === 'staff' ? 'staff-message' : ''}">
    <div class="service-heading"><strong>${h(message.author_kind === 'staff' ? 'supportTeam' : 'supportCustomer')}</strong>
      <small><bdi>${esc(dateLabel(message.created_at))}</bdi></small></div>
    <p>${message.sample ? h('supportSampleBody') : esc(message.message)}</p></li>`).join('')}</ol>`;
}

export function supportReplyForm(ticket, staff = false) {
  return `<form class="form" id="${staff ? 'staff-reply-form' : 'support-reply-form'}" data-id="${esc(ticket.id)}">
    <input type="hidden" name="request_key" value="${requestKey()}">
    ${staff ? `<input type="hidden" name="updated_at" value="${esc(ticket.updated_at)}">` : ''}
    <label class="field">${h('supportReply')}<textarea name="message" minlength="5" maxlength="3000" required></textarea></label>
    <div class="form-error" hidden></div>
    <button class="primary wide" type="submit">${h(!staff && ticket.status === 'resolved' ? 'supportReopen' : 'supportSend')}</button>
  </form>`;
}

export function supportThread(ticket, demo) {
  return `<div class="sheet-content"><div class="eyebrow">${h('support')}</div>
    <h2 id="sheet-title">${esc(ticket.subject)}</h2>
    <div class="service-heading">${ticketStatus(ticket.status)}
      <button class="text-button" data-action="support-ticket" data-id="${esc(ticket.id)}">${h('staffRefresh')}</button></div>
    ${supportMessages(ticket)}${supportReplyForm(ticket)}
    ${demo && ticket.status === 'open' ? `<button class="secondary wide" data-action="support-sample-reply" data-id="${esc(ticket.id)}">${h('supportSampleReply')}</button>` : ''}
  </div>`;
}
