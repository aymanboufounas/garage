import { mountModeration } from './moderation.js';
import { api } from './data.js';
import { applyDocumentLanguage, language, languageNames, setLanguage, t } from './i18n.js';
import { dateLabel, esc } from './icons.js';
import { localizeError } from './errors.js';
import { supportMessages, supportReplyForm, ticketStatus } from './service-ui.js';

const $ = selector => document.querySelector(selector);
const root = $('#staff-app');
const h = (key, params) => esc(t(key, params));
const statuses = ['open', 'waiting', 'resolved'];
const state = {
  user: null, demo: false, queue: null, ticket: null,
  filters: { status: 'all', q: '', mine: false }
};
let ticketRead = 0;
let queueRead = 0;

function renderHeader() {
  applyDocumentLanguage();
  document.title = `${t(state.user?.staff_role === 'admin' ? 'moderationDashboard' : 'staffDashboard')} · GarageShare`;
  $('#staff-header').innerHTML = `<a class="brand" href="./" aria-label="${h('staffBack')}">
    <img src="./assets/logo.svg" alt=""><bdi>GarageShare</bdi></a>
    <div class="staff-header-actions">
      <select id="staff-language" class="language-picker" aria-label="${h('language')}">
        ${Object.entries(languageNames).map(([code, name]) => `<option value="${code}" ${language() === code ? 'selected' : ''}>${esc(name)}</option>`).join('')}
      </select>
      ${state.user ? `<button class="secondary" data-staff-action="logout">${h('signOut')}</button>` : ''}
    </div>`;
}

function renderGate() {
  renderHeader();
  const message = state.demo ? h('staffPreview') : state.user
    ? esc(localizeError('Staff access is required.', language())) : h('staffSignedOut');
  root.innerHTML = `<section class="staff-gate"><h1>${h('staffDashboard')}</h1><p>${message}</p>
    ${!state.demo && !state.user ? `<form id="staff-login-form" class="form">
      <label class="field">${h('email')}<input type="email" name="email" autocomplete="username" maxlength="190" required></label>
      <label class="field">${h('password')}<input type="password" name="password" autocomplete="current-password" minlength="12" maxlength="128" required></label>
      <div class="form-error" hidden></div><button class="primary wide" type="submit">${h('signIn')}</button>
    </form>` : ''}<div id="staff-notice" class="staff-notice" role="status" hidden></div>
    <a href="./" class="text-button">${h('staffBack')}</a></section>`;
  root.setAttribute('aria-busy', 'false');
}

function statusOptions(selected, includeAll = false) {
  const options = includeAll ? ['all', ...statuses] : statuses;
  return options.map(value => `<option value="${value}" ${selected === value ? 'selected' : ''}>
    ${h(value === 'all' ? 'staffAll' : `support_status_${value}`)}</option>`).join('');
}

function renderDashboard() {
  renderHeader();
  root.innerHTML = `<div class="eyebrow">${state.user?.staff_role === 'admin' ? 'GarageShare' : h('supportTeam')}</div><h1>${h(state.user?.staff_role === 'admin' ? 'moderationDashboard' : 'staffDashboard')}</h1><p class="page-intro">${h(state.user?.staff_role === 'admin' ? 'moderationDashboardIntro' : 'staffIntro')}</p>
    <div id="staff-notice" class="staff-notice" role="status" hidden></div>
    ${state.user?.staff_role === 'admin' ? '<section id="moderation-panel" class="staff-panel"></section>' : ''}
    <div id="staff-counts" class="staff-counts"></div>
    <div class="staff-layout">
      <section class="staff-panel" aria-label="${h('staffAll')}">
        <form class="staff-filters form" id="staff-filter-form">
          <label class="field">${h('staffSearch')}<input type="search" name="q" value="${esc(state.filters.q)}" maxlength="120"></label>
          <label class="field">${h('staffStatus')}<select name="status">${statusOptions(state.filters.status, true)}</select></label>
          <label class="staff-checkbox"><input type="checkbox" name="mine" ${state.filters.mine ? 'checked' : ''}> ${h('staffMine')}</label>
          <button class="secondary" type="submit">${h('staffFilter')}</button>
        </form>
        <div id="staff-queue" class="staff-queue"></div>
      </section>
      <section class="staff-panel staff-thread-panel" id="staff-thread" aria-live="polite"></section>
    </div>`;
  if (state.user?.staff_role === 'admin') mountModeration($('#moderation-panel'), api);
  renderQueue();
  renderTicket();
  root.setAttribute('aria-busy', 'false');
}

function renderQueue() {
  const list = $('#staff-queue');
  if (!list) return;
  const { counts = {}, tickets = [], has_more } = state.queue || {};
  $('#staff-counts').innerHTML = statuses.map(status => `<div class="staff-count">
    <strong>${Number(counts[status] || 0)}</strong><span>${h(`support_status_${status}`)}</span></div>`).join('');
  list.innerHTML = tickets.length ? tickets.map(ticket => `<button class="ticket-row" data-staff-action="ticket" data-id="${esc(ticket.id)}"
    ${state.ticket?.id === ticket.id ? 'aria-current="true"' : ''}>
    <span><strong>${esc(ticket.subject)}</strong>
      <small>${esc(ticket.customer_name)} · ${h(`support_category_${ticket.category}`)}</small>
      <small>${esc(ticket.assignee_name || t('staffUnassigned'))} · <bdi>${esc(dateLabel(ticket.updated_at))}</bdi></small></span>
    ${ticketStatus(ticket.status)}</button>`).join('') : `<p class="small">${h('staffEmpty')}</p>`;
  if (has_more) list.insertAdjacentHTML('beforeend', `<p class="small">${h('staffLimited')}</p>`);
}

function assignmentField(ticket) {
  const { role, actor_id, staff } = state.queue;
  const editable = role === 'admin' || !ticket.assignee_id || ticket.assignee_id === actor_id;
  if (!editable) {
    const member = staff.find(person => person.id === ticket.assignee_id);
    return `<p class="small">${h('staffAssignee')} · ${esc(member?.name || t('staffUnassigned'))}</p>`;
  }
  const choices = role === 'admin' ? staff : staff.filter(person => person.id === actor_id);
  return `<label class="field">${h('staffAssignee')}<select name="assignee_id">
    <option value="">${h('staffUnassigned')}</option>
    ${choices.map(person => `<option value="${esc(person.id)}" ${person.id === ticket.assignee_id ? 'selected' : ''}>${esc(person.id === actor_id ? t('staffAssignMe') : person.name)}</option>`).join('')}
  </select></label>`;
}

function renderTicket() {
  const panel = $('#staff-thread');
  if (!panel) return;
  const ticket = state.ticket;
  if (!ticket || !state.queue) {
    panel.innerHTML = `<p class="small">${h('staffPick')}</p>`;
    return;
  }
  panel.innerHTML = `<div class="service-heading">${ticketStatus(ticket.status)}
    <button class="text-button" data-staff-action="ticket" data-id="${esc(ticket.id)}">${h('staffRefresh')}</button></div>
    <h2 id="staff-ticket-title" tabindex="-1">${esc(ticket.subject)}</h2>
    <p class="small">${h(`support_category_${ticket.category}`)} · ${esc(ticket.customer.name)} · <bdi>${esc(ticket.customer.email)}</bdi></p>
    <p class="small"><bdi>${esc(ticket.id)}</bdi></p>
    <form id="staff-update-form" class="form staff-ticket-settings" data-id="${esc(ticket.id)}">
      <input type="hidden" name="updated_at" value="${esc(ticket.updated_at)}">
      <label class="field">${h('staffStatus')}<select name="status">${statusOptions(ticket.status)}</select></label>
      ${assignmentField(ticket)}
      <div class="form-error" hidden></div><button class="secondary" type="submit">${h('staffSave')}</button>
    </form>${supportMessages(ticket)}${supportReplyForm(ticket, true)}`;
}

function notice(message, error = false) {
  const el = $('#staff-notice');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('warning', error);
  el.hidden = !message;
}

async function fetchQueue() {
  const revision = ++queueRead;
  const params = new URLSearchParams({ status: state.filters.status, q: state.filters.q, mine: state.filters.mine ? '1' : '0' });
  const queue = await api('/staff/queue?' + params);
  if (revision === queueRead) {
    state.queue = queue;
    renderQueue();
  }
}

async function signInView() {
  if (!state.user?.staff_role || state.demo) {
    renderGate();
    return;
  }
  renderDashboard();
  await fetchQueue();
}

function forgetStaffState() {
  ticketRead++;
  queueRead++;
  state.user = null;
  state.queue = null;
  state.ticket = null;
  state.filters = { status: 'all', q: '', mine: false };
  renderGate();
}

function showError(error, form) {
  if (error.status === 401 && state.user) forgetStaffState();
  const message = localizeError(error.message, language());
  const field = form?.isConnected && form.querySelector('.form-error');
  if (field) {
    field.textContent = message;
    field.hidden = false;
  } else notice(message, true);
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-staff-action]');
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    if (button.dataset.staffAction === 'logout') {
      await api('/logout', 'POST', {});
      forgetStaffState();
    } else if (button.dataset.staffAction === 'ticket') {
      const revision = ++ticketRead;
      const { ticket } = await api(`/staff/tickets/${button.dataset.id}`);
      if (revision !== ticketRead) return;
      state.ticket = ticket;
      renderQueue();
      renderTicket();
      $('#staff-ticket-title')?.focus({ preventScroll: true });
      $('#staff-thread')?.scrollIntoView({ block: 'nearest' });
      notice('');
    }
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const submit = form.querySelector('[type="submit"]');
  if (!submit || submit.disabled) return;
  submit.disabled = true;
  const field = form.querySelector('.form-error');
  if (field) field.hidden = true;
  const data = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'staff-login-form') {
      state.user = (await api('/login', 'POST', data)).user;
      await signInView();
    } else if (form.id === 'staff-filter-form') {
      state.filters = { status: data.status, q: data.q.trim(), mine: Boolean(data.mine) };
      await fetchQueue();
      notice('');
    } else if (['staff-reply-form', 'staff-update-form'].includes(form.id)) {
      const action = form.id === 'staff-reply-form' ? 'reply' : 'update';
      data.updated_at = Number(data.updated_at);
      if (data.assignee_id === '') data.assignee_id = null;
      const { ticket } = await api(`/staff/tickets/${form.dataset.id}/${action}`, 'POST', data);
      if (state.ticket?.id === ticket.id) {
        state.ticket = ticket;
        renderTicket();
      }
      notice(t('staffSaved'));
      await fetchQueue();
    }
  } catch (error) {
    showError(error, form);
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener('change', event => {
  if (event.target.id !== 'staff-language' || !setLanguage(event.target.value)) return;
  if (state.user?.staff_role && !state.demo) renderDashboard();
  else renderGate();
});

window.garageshareBack = () => {
  location.assign('./');
  return true;
};

async function start() {
  renderHeader();
  try {
    const [config, session] = await Promise.all([api('/config'), api('/session')]);
    state.demo = config.demo;
    state.user = session.user;
    await signInView();
  } catch (error) {
    renderGate();
    showError(error);
  }
}

start();
