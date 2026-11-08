export function reservationChatOpen(reservation, now = Date.now()) {
  if (reservation.status === 'confirmed') return reservation.ends_at > now;
  return ['requested', 'countered'].includes(reservation.status) &&
    reservation.starts_at > now && reservation.expires_at > now;
}

export function quoteChatOpen(quote, request, booking, now = Date.now()) {
  if (booking) return reservationChatOpen(booking, now);
  return quote.status === 'quoted' && request.status === 'open' &&
    request.starts_at > now && request.expires_at > now;
}
