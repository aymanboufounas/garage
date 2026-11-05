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

The 0.2.1 preview (version code 3) was compiled from the supplied Java source and bundled web assets with Android SDK Platform 36, Build Tools 36.0.0, Eclipse Java compiler and D8, then zip-aligned and signed with a development certificate. APK signature schemes v2 and v3 verified successfully. Package metadata confirms `ma.garageshare.app.preview`, minimum API 26, target API 36, INTERNET and optional coarse-location permissions, and the MainActivity launcher. The signing certificate matches version 0.2.0 so this is an in-place preview update.

The normal Gradle project and wrapper are included for Android Studio. The build runner could not resolve the Gradle Android plugin over its network, so the delivered APK used the included standalone SDK build path. No Gradle build success is claimed.

**Not tested here:** installation or runtime on a physical Android device, native permission dialogs, device-specific keyboard/insets, the Play Store release process, a deployed HTTPS service, real property data, external host handover, or payment processing. Real-device and live-environment testing remain necessary.

## GarageShare 0.2.0 localization

The complete English smoke workflow still passed 18 checks. `node scripts/check-locales.cjs` passed 31 checks for French and Arabic: persistent language choice, RTL/LTR, mobile overflow, translated sample listings, monthly bookings, language changes preserving data, cancellations, host forms, validation messages, privacy and map guidance. No browser errors were observed. `npm test` passed 21 checks including complete translation catalogs and localized HTTP errors.

## GarageShare 0.2.1 map and headline repair

The mobile map now occupies the space between the real header and navigation in a flex layout. Its return-to-list button belongs to the map surface and remains above the bottom navigation. The map uses the visible viewport height and updates Leaflet's size while retaining its center. Entering the map hides the list and restores its scroll position on return. The discovery headline uses upright DM Sans for English/French and retains Cairo for Arabic.

The Android container already applies system-bar padding. It now forwards zero system-bar and cutout insets to WebView while retaining keyboard inset updates, avoiding a second application of the same padding. This follows Android's [WebView inset guidance](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets).

`node scripts/check-map-layout.cjs` passed **39 checks**, with no browser errors. At 360 px width it checks English, French and Arabic: the complete return button is visible and receives touches, nearby price pins remain inside the map, the map fills the available area, navigation reaches the visible viewport bottom, and opening the map does not expose the scrolled list. It also checks a simulated visual-viewport reduction from 800 to 650 px, a 480 px tall screen, desktop resizing, retained input focus and restored list scroll. Tile requests are deliberately blocked in this geometry suite; the separate 18-check workflow verified real tile rendering. The 31 localization checks also passed again.

The geometry tests emulate WebView viewport changes in Chromium. The native inset adjustment compiled successfully but still needs confirmation on the user's physical phone.

![Mobile map after the repair](screenshots/map-fixed.webp)
