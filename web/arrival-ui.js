import { esc, icon } from './icons.js';
import { t } from './i18n.js';

const h = key => esc(t(key));

export function drivingDirections(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error('The garage entrance is unavailable.');
  }
  const query = new URLSearchParams({ api: '1', destination: `${latitude},${longitude}`,
    travelmode: 'driving', dir_action: 'navigate' });
  return `https://www.google.com/maps/dir/?${query}`;
}

export function arrivalSheet(arrival) {
  const route = drivingDirections(arrival.latitude, arrival.longitude);
  return `<div class="sheet-content arrival-content">
    <div class="eyebrow">${h(arrival.is_demo ? 'arrivalSample' : 'arrivalTitle')}</div>
    <h2 id="sheet-title">${esc(arrival.garage_name)}</h2>
    ${arrival.address ? `<p class="arrival-address">${icon('pin')}<span>${esc(arrival.address)}</span></p>` : ''}
    ${arrival.is_demo ? `<p class="small">${h('arrivalSampleNote')}</p>` : ''}
    <div id="arrival-map" class="arrival-map" aria-label="${h('arrivalTitle')}"></div>
    <p id="arrival-map-status" class="small" hidden>${h('arrivalMapUnavailable')}</p>
    <p class="small">${h('arrivalRouteNote')}</p>
    <a class="primary wide arrival-link" id="arrival-directions" href="${esc(route)}" rel="noreferrer">
      ${icon('directions')}${h(arrival.is_demo ? 'arrivalSampleDrive' : 'arrivalDrive')}</a>
  </div>`;
}
