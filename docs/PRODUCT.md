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
| Explore | City → period → garage → dates → confirmation |
| Saved | Keep spaces on this device |
| Trips | Booking status, price offers, private entrance, cancellation |
| Host | List a garage, review reservations, accept/counter offers |

The account icon contains authentication and privacy details. One account can host and rent. Map access and location permission are optional; search works with a manually chosen city. The interface supports English, French and Arabic. The saved language selector updates labels, dates, prices, messages and Arabic RTL layout without changing booking identifiers or data.

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

## Trust language

The demo never describes sample properties as real or verified. Moderation is a manual review step, not proof of identity, legal ownership or physical safety. The UI contains no fabricated ratings or reviews. Accurate photos and host permission are prerequisites for approval.

## Next release

Add account recovery and verified email, real photo uploads with metadata stripping and malware/content checks, host verification evidence, in-app handover messaging, support/reporting, and provider-backed payments only after selecting a suitable Moroccan payment/payout provider. These are scope gaps, not features hidden behind inactive buttons.
