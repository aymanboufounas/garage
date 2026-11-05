# Validation for this delivery

## Backend

`npm test` completed with **21 passing checks**, zero failures. Coverage includes calendar months, leap years and invalid dates; HTTPS-only production configuration; rate limiting against forged proxy headers; account session rotation; CSRF and origin rejection; moderation visibility; approximate coordinates; owner/guest permissions; authoritative integer pricing; concurrent overlapping bookings; idempotent requests; private entrances; offer/counter acceptance; competing bookings; cancellation; expiry; database overlap triggers; static file restrictions; and logout revocation.

These are local integration tests using a temporary SQLite database and real HTTP requests. Test identities use example.com addresses and no email is sent. They are not a penetration test or a production load test.

## Interface

The optional `node scripts/check-ui.cjs` browser workflow completed **18 checks**, with no uncaught browser errors. It exercised mobile discovery, map price pins, visible OpenStreetMap tiles, saving, monthly prices, details, booking forms, negotiation, confirmation, conflict errors, cancellation, host entrance selection, pending listings, escaped markup, preview approval, host counter offers and horizontal overflow at 320 px and 390 px.

The isolated browser runner could not fetch external map tiles directly. For the successful tile-rendering check, `QA_TILE_RELAY=1` fetched the exact visible OpenStreetMap PNG requests through curl and fulfilled them to the browser. The application itself contains no tile relay or certificate bypass. A separate run verified the map's network-failure message and the continuing availability of list search. Screenshots are browser renders, not physical-device captures.

To reproduce with a normal browser environment:

```bash
npm install --no-save playwright
npx playwright install chromium
node scripts/check-ui.cjs
```

CI may pass `BROWSER_EXECUTABLE` for an installed Chromium. `BROWSER_SINGLE_PROCESS=1`, `BROWSER_PROXY`, and `QA_TILE_RELAY=1` are optional runner workarounds. Production dependencies do not require Playwright.

## Android package

The preview was compiled from the supplied Java source and bundled web assets with Android SDK Platform 36, Build Tools 36.0.0, Eclipse Java compiler and D8, then zip-aligned and signed with a development certificate. APK signature schemes v2 and v3 verified successfully. Package metadata confirms `ma.garageshare.app.preview`, minimum API 26, target API 36, INTERNET and optional coarse-location permissions, and the MainActivity launcher.

The normal Gradle project and wrapper are included for Android Studio. The build runner could not resolve the Gradle Android plugin over its network, so the delivered APK used the included standalone SDK build path. No Gradle build success is claimed.

**Not tested here:** installation or runtime on a physical Android device, native permission dialogs, device-specific keyboard/insets, the Play Store release process, a deployed HTTPS service, real property data, external host handover, or payment processing. Real-device and live-environment testing remain necessary.

## GarageShare 0.2.0 localization

The complete English smoke workflow still passed 18 checks. `node scripts/check-locales.cjs` passed 31 checks for French and Arabic: persistent language choice, RTL/LTR, mobile overflow, translated sample listings, monthly bookings, language changes preserving data, cancellations, host forms, validation messages, privacy and map guidance. No browser errors were observed. `npm test` passed 21 checks including complete translation catalogs and localized HTTP errors.
