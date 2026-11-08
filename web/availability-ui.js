import { dateLabel, esc, fromMoroccoInput, icon, moroccoInput } from './icons.js';
import { duration, locale, localizedField, t } from './i18n.js';
import { requestKey } from './data.js';

const h = (key, params) => esc(t(key, params));
const hour = 3600000;
const dayKey = date => date.toISOString().slice(0, 10);
const dayStart = key => fromMoroccoInput(`${key}T00:00`);

export function availabilityBar(period) {
  return `<div class="availability-bar">
    <button class="secondary" data-action="availability-form">${icon('calendar')}${h('availabilityDates')}</button>
    ${period ? `<span><bdi>${esc(dateLabel(period.starts_at))}</bdi> · ${esc(duration(period.units, period.mode))}</span>
      <button class="text-button" data-action="availability-clear">${h('availabilityClear')}</button>` : ''}
  </div>`;
}

export function availabilityForm(mode, period) {
  const now = Date.now();
  const start = period?.starts_at ?? Math.ceil((now + hour) / hour) * hour;
  return `<div class="sheet-content"><div class="eyebrow">${h(mode)}</div>
    <h2 id="sheet-title">${h('availabilityTitle')}</h2><p class="small">${h('availabilityIntro')}</p>
    <form id="availability-form" class="form">
      <label class="field">${h('startMorocco')}<input type="datetime-local" name="start" value="${moroccoInput(start)}" min="${moroccoInput(now + 60000)}" required></label>
      <label class="field">${h(mode === 'hourly' ? 'hours' : 'months')}<input type="number" name="units" value="${period?.units ?? (mode === 'hourly' ? 3 : 1)}" min="1" max="${mode === 'hourly' ? 168 : 12}" required></label>
      <div class="form-error" hidden></div><button class="primary wide" type="submit">${h('availabilitySearch')}</button>
    </form></div>`;
}

export function calendarMonth(month) {
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const next = new Date(Date.UTC(year, number, 1));
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const days = Array.from({ length: last }, (_, i) => {
    const key = dayKey(new Date(Date.UTC(year, number - 1, i + 1)));
    const following = dayKey(new Date(Date.UTC(year, number - 1, i + 2)));
    return { key, number: i + 1, starts_at: dayStart(key), ends_at: dayStart(following) };
  });
  return {
    from: new Date(days[0].starts_at).toISOString(),
    to: new Date(days.at(-1).ends_at).toISOString(),
    previous: dayKey(new Date(Date.UTC(year, number - 2, 1))).slice(0, 7),
    next: dayKey(next).slice(0, 7),
    offset: (first.getUTCDay() + 6) % 7,
    label: new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first),
    days
  };
}

function onDay(event, day) {
  return event.starts_at < day.ends_at && event.ends_at > day.starts_at;
}

export function calendarPanel(listings, garageId, month, selected, agenda, demo) {
  if (!listings.length) return `<section class="service-section"><p class="small">${h('calendarEmpty')}</p>
    ${demo ? `<button class="secondary" data-action="calendar-sample">${h('calendarSample')}</button>` : ''}</section>`;
  const weekday = new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' });
  const weekdays = Array.from({ length: 7 }, (_, i) => weekday.format(new Date(Date.UTC(2024, 0, 1 + i))));
  const day = month.days.find(value => value.key === selected);
  const selectedEvents = [...agenda.bookings.map(row => ({ ...row, type: 'booked' })), ...agenda.blocks.map(row => ({ ...row, type: 'blocked' }))]
    .filter(event => onDay(event, day)).sort((a, b) => a.starts_at - b.starts_at);
  return `<section class="service-section calendar-panel">
    <div class="service-heading"><h2>${h('calendar')}</h2></div><p class="small">${h('calendarIntro')}</p>
    <label class="field calendar-picker">${h('calendarGarage')}<select id="calendar-garage">
      ${listings.map(g => `<option value="${esc(g.id)}" ${g.id === garageId ? 'selected' : ''}>${esc(localizedField(g, 'name'))}</option>`).join('')}
    </select></label>
    <div class="calendar-month service-heading">
      <button class="secondary" data-action="calendar-month" data-month="${month.previous}" aria-label="${h('calendarPrev')}">‹</button>
      <strong>${esc(month.label)}</strong>
      <button class="secondary" data-action="calendar-month" data-month="${month.next}" aria-label="${h('calendarNext')}">›</button>
    </div>
    <div class="calendar-grid">
      ${weekdays.map(label => `<span class="calendar-weekday">${esc(label)}</span>`).join('')}
      ${'<span aria-hidden="true"></span>'.repeat(month.offset)}
      ${month.days.map(value => {
        const booked = agenda.bookings.some(event => onDay(event, value));
        const blocked = agenda.blocks.some(event => onDay(event, value));
        const label = booked ? t('calendarDayBooked', { date: value.key }) : blocked
          ? t('calendarDayBlocked', { date: value.key }) : value.key;
        return `<button class="calendar-day" data-action="calendar-day" data-date="${value.key}" aria-pressed="${value.key === selected}" aria-label="${esc(label)}">
          <span>${value.number}</span><span class="calendar-dots" aria-hidden="true">${booked ? '<i class="calendar-dot booked"></i>' : ''}${blocked ? '<i class="calendar-dot blocked"></i>' : ''}</span></button>`;
      }).join('')}
    </div>
    <div class="calendar-legend small"><span><i class="calendar-dot booked"></i>${h('calendarBooked')}</span><span><i class="calendar-dot blocked"></i>${h('calendarBlocked')}</span></div>
    <div class="calendar-agenda" id="calendar-agenda">
      <div class="service-heading"><strong><bdi>${esc(selected)}</bdi></strong><button class="primary" data-action="calendar-block" ${day.ends_at <= Date.now() ? 'disabled' : ''}>${h('calendarBlock')}</button></div>
      ${selectedEvents.length ? selectedEvents.map(event => `<article class="calendar-event ${event.type}">
        <strong>${h(event.type === 'booked' ? 'calendarBooked' : 'calendarBlocked')}</strong>
        <p class="small"><bdi>${esc(dateLabel(event.starts_at))} → ${esc(dateLabel(event.ends_at))}</bdi></p>
        ${event.note ? `<p class="small">${esc(event.note)}</p>` : ''}
        ${event.type === 'blocked' ? `<button class="text-button" data-action="calendar-unblock" data-id="${esc(event.id)}">${h('calendarUnblock')}</button>` : ''}
      </article>`).join('') : `<p class="small">${h('calendarFreeDay')}</p>`}
    </div></section>`;
}

export function blockForm(garageId, selected) {
  const earliest = Math.ceil(Date.now() / 60000) * 60000;
  const start = Math.max(earliest, fromMoroccoInput(`${selected}T09:00`));
  const end = Math.max(start + hour, fromMoroccoInput(`${selected}T18:00`));
  return `<div class="sheet-content"><h2 id="sheet-title">${h('calendarBlock')}</h2>
    <form class="form" id="calendar-block-form" data-id="${esc(garageId)}">
      <input type="hidden" name="request_key" value="${requestKey()}">
      <label class="field">${h('startMorocco')}<input type="datetime-local" name="start" min="${moroccoInput(earliest)}" value="${moroccoInput(start)}" required></label>
      <label class="field">${h('calendarEnd')}<input type="datetime-local" name="end" value="${moroccoInput(end)}" required></label>
      <label class="field">${h('calendarNote')}<input name="note" maxlength="200"></label>
      <div class="form-error" hidden></div><button class="primary wide" type="submit">${h('calendarBlock')}</button>
    </form></div>`;
}
