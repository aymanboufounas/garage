import { dateLabel, esc } from './icons.js';
import { t } from './i18n.js';

const h = (key, params) => esc(t(key, params));

export function ratingBadge(garage) {
  if (!garage.review_count) return '';
  return `<span class="rating-badge" aria-label="${h('reviewStars', { rating: garage.rating })}">
    <span aria-hidden="true">★</span> <bdi>${esc(garage.rating)} (${esc(garage.review_count)})</bdi></span>`;
}

function reviewCard(row, title) {
  return `<article class="review-card"><div class="service-heading"><strong>${h(title)}</strong>
    <span class="rating-badge" aria-label="${h('reviewStars', { rating: row.rating })}"><span aria-hidden="true">★</span> <bdi>${esc(row.rating)}/5</bdi></span></div>
    <p class="small"><bdi>${esc(dateLabel(row.created_at))}</bdi></p>
    ${row.sample || row.comment ? `<p class="review-comment">${row.sample ? h('reviewSampleText') : esc(row.comment)}</p>` : ''}</article>`;
}

export function garageReviewSheet(name, reviews) {
  return `<div class="sheet-content"><h2 id="sheet-title">${h('garageReviews')}</h2><p class="small">${esc(name)}</p>
    ${reviews.length ? reviews.map(row => reviewCard(row, 'reviewVerified')).join('') : `<p class="small">${h('reviewEmpty')}</p>`}</div>`;
}

export function stayReviewSheet(view, demo) {
  const pending = h('reviewPending', { date: dateLabel(view.deadline) });
  return `<div class="sheet-content"><h2 id="sheet-title">${h('reviewTitle')}</h2><p class="small">${esc(view.garage_name)}</p>
    ${view.mine ? reviewCard(view.mine, 'reviewMine') : ''}
    ${view.other ? reviewCard(view.other, 'reviewOther') : ''}
    ${view.mine ? `<p class="small" id="review-status">${view.published ? h('reviewPublished') : pending}</p>` : ''}
    ${view.can_review ? `<form class="form" id="stay-review-form" data-id="${esc(view.reservation_id)}">
      <p class="small">${h(view.role === 'renter' ? 'reviewRenterNotice' : 'reviewHostNotice')}</p>
      <p class="small">${pending}</p>
      <fieldset class="rating-options"><legend>${h('reviewRating')}</legend>
        ${[1, 2, 3, 4, 5].map(rating => `<label><input type="radio" name="rating" value="${rating}" aria-label="${h('reviewStars', { rating })}" required><span><bdi>${rating} ★</bdi></span></label>`).join('')}
      </fieldset>
      <label class="field">${h('reviewComment')}<textarea name="comment" maxlength="1000"></textarea></label>
      <div class="form-error" hidden></div><button type="submit" class="primary wide">${h('reviewSubmit')}</button>
    </form>` : !view.mine && !view.other ? `<p class="small">${h('reviewClosed')}</p>` : ''}
    ${demo && view.mine && !view.published ? `<button class="secondary wide" data-action="review-sample-reply" data-id="${esc(view.reservation_id)}">${h('reviewSampleReply')}</button>` : ''}</div>`;
}
