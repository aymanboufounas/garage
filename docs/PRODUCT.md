# Product decisions

## Name and logo

**GarageShare** is the app name selected by the owner. The original garage/location icon is retained with the updated wordmark. No trademark or domain availability claim is made.

Tagline: **A place for your car.**

## Public product patterns used

Airbnb's public help documents explain photo/listing discovery, filters, map search, and monthly pricing. inDrive's public help explains proposing a price and accepting or countering it. These public workflows informed the product model; the implementation, interface, logo and backend are original.

- https://www.airbnb.com/help/article/252
- https://www.airbnb.com/help/article/3511
- https://indrive.com/fr-ma/city-rides
- https://indrive.com/fr-ma/help/passengers/how-fares-are-calculated

No proprietary source, private API, brand asset, user data, or competitor account is used.

## Simple navigation

| Tab | Main job |
| --- | --- |
| Explore | Browse a garage, book at the listed price, or request quotes from several garages |
| Saved | Keep spaces on this device |
| Trips | Compare host quotes, choose one garage, and manage confirmed stays |
| Host | List a garage, manage bookings, and answer price requests |

The account icon opens authentication, privacy and support. Support is also available from a booking. One account can host and rent. Users can search by city and optionally grant location access for the map. English, French and Arabic share the same bookings and ticket history.

## Booking rules

- Money is integer centimes internally; display uses DH/MAD.
- Hourly: 1–168 hours. Monthly: 1–12 calendar months. The arrival must be at least one minute in the future and within one year.
- A month keeps the local Morocco date and time, clamping an unavailable day to the last day. January 31 plus one month ends on February 28 or 29. Nonexistent local end times during a clock change are rejected.
- Listed-price booking is instant for an approved space. The server computes the total and end time.
- Guest offers can range from 60% to 200% of the listed total. They hold no availability. Offers expire within 24 hours or by the start.
- A host can accept a new offer or counter once. Only the guest can accept a host counter. An acceptance rechecks availability atomically.
- Confirmed reservations block the complete interval, including overlaps between hourly and monthly bookings. Adjacent bookings are allowed.
- Either party can cancel before the start. There are no payments or refunds inside this MVP.
- No recurring billing, automatic extension, security deposit, access key generation, or insurance is implied.

## Competing garage quotes

The renter picks dates, an hourly or monthly duration, a proposed total and up to five approved garages in one city. Invited hosts can match the price, send a counter quote or decline. The renter sees the replies with the garage area, vehicle fit and price in Trips. The final selection checks the stored price and current availability in one database transaction, then creates one confirmed reservation. Requests close on selection, cancellation or expiry. Exact entrance information follows confirmation through the existing booking flow.

## Support

Customers open a ticket from their account or attach a booking they own or host. Staff can search the queue, reply, assign an owner and resolve issues. A customer reply reopens the ticket. The preview includes sample replies for practice on the device.

## Trust language

The demo never describes sample properties as real or verified. Moderation is a manual review step, not proof of identity, legal ownership or physical safety. The UI contains no fabricated ratings or reviews. Accurate photos and host permission are prerequisites for approval.

## Next release

Add account recovery, verified email, account deletion, host verification evidence and photo uploads with metadata removal. The current host payment method is pay on arrival.
