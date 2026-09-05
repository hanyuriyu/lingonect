# Lingonect for Android

The Android app is the **same web app** as the website, wrapped in
[Capacitor](https://capacitorjs.com) — exactly like the iOS app. There is no
separate Android codebase: `scripts/copy-web.mjs` copies the HTML/CSS/images
into `www/`, and Capacitor bundles `www/` into the native project under
`android/`.

Unlike iOS, **Android needs no Mac and no paid account to test.** GitHub Actions
builds an installable APK on every push; you download it and install it on a
phone.

---

## Your part, in order

Three of these are quick. Only the last one (Play Store) is a long haul, and you
can test on both your phones without ever touching it.

| # | Step | Where | Needed for |
|---|------|-------|-----------|
| 1 | Register the Android app in Firebase | Firebase Console | Google Sign-In |
| 2 | Add `google-services.json` to the repo | GitHub | Google Sign-In |
| 3 | Install the APK on your phones | Pixel / Galaxy Flip | Testing |
| 4 | Play Store publishing | Play Console | Public release |

You can do **step 3 first** and skip 1–2 if you only want to look at the app —
email/password login works without any Firebase setup. Google Sign-In is the
only thing that needs steps 1–2.

---

## Step 1 — Register the Android app in Firebase

Google Sign-In on Android is verified against the app's **package name** plus
the **SHA-1 fingerprint of the key that signed the APK**. Both have to be
registered, or Google returns a bare `code 10` error with no explanation.

1. Open the [Firebase Console](https://console.firebase.google.com/) and select
   the existing **lingonect-4db51** project (the same one the website uses — do
   not create a new project, or the app would see a different user database).
2. Project settings (gear icon) → **Your apps** → **Add app** → **Android**.
3. Fill in:
   - **Android package name:** `com.lingonect.app`
     — this must match exactly; it is set in `android/app/build.gradle`.
   - **App nickname:** `Lingonect Android` (cosmetic).
   - **Debug signing certificate SHA-1:** paste the fingerprint below.

### The fingerprint to paste

Every test build — from GitHub Actions or from your own Mac — is signed with the
shared debug key committed at `android/lingonect-debug.keystore`, so there is
exactly **one** fingerprint to register:

```
SHA-1    24:0D:CD:9D:AE:43:E6:25:E9:8A:8A:65:2F:7F:CF:ED:1B:F3:99:C3
SHA-256  A8:0A:CA:4B:F4:F2:8C:40:41:CE:DB:52:54:28:37:BE:D3:1B:F4:5C:D3:22:E1:14:78:68:A0:04:0C:40:34:66
```

Add the SHA-256 as well (Firebase accepts several fingerprints per app; use
**Add fingerprint** for the second one). You can re-derive them any time with:

```bash
keytool -list -v -keystore android/lingonect-debug.keystore \
  -alias lingonectdebug -storepass lingonectdebug
```

> **Why a committed debug key?** Android normally signs debug builds with a
> keystore generated per machine, and CI runners generate a fresh one on every
> run — so the fingerprint would change constantly and Google Sign-In would only
> work on whichever machine you happened to register. One shared debug key gives
> one stable fingerprint. It signs **test builds only**: releases use the
> separate keystore in step 4, and Play rejects a debug-signed upload. Worst
> case if it leaks, someone can build an app that signs *themselves* in — the
> Firebase database rules still govern what anyone can read or write.

## Step 2 — Add `google-services.json`

Firebase will offer a `google-services.json` download at the end of step 1.

This file is **client configuration, not a secret** — the same values are
already visible in `login.html`, and they ship inside every APK. Firebase's own
docs treat it as safe to commit, and committing it is what lets CI builds have
working Google Sign-In.

```bash
# from the repo root, with the downloaded file in ~/Downloads
cp ~/Downloads/google-services.json android/app/google-services.json
git add android/app/google-services.json
git commit -m "Add Firebase Android client config"
git push
```

If you would rather not commit it, add its **contents** as a repository secret
named `GOOGLE_SERVICES_JSON` (GitHub → Settings → Secrets and variables →
Actions) instead; the workflow writes it out at build time either way.

Without this file the app still builds and runs — you just get email/password
login, and the Google button reports that sign-in is unavailable.

## Step 3 — Get the app onto your phones

### Getting the APK

Every push to `main` or a `claude/**` branch runs the **Android** workflow and
attaches the APK as a build artifact.

1. GitHub → **Actions** tab → the most recent **Android** run.
2. Scroll to **Artifacts** → download `lingonect-debug-<sha>.zip`.
3. Unzip it. Inside is `app-debug.apk`.

You can also trigger a build by hand: Actions → Android → **Run workflow**.

### Installing on the Pixel 10 Pro

The simplest route needs no cable:

1. Upload `app-debug.apk` to Google Drive, or email it to yourself.
2. On the Pixel, open the file. Chrome/Files will warn that installing unknown
   apps is blocked — tap **Settings** and allow it for that app, then go back
   and tap **Install**.
3. Play Protect will show "Unsafe app blocked" or ask to scan it. This is
   expected for any app not distributed through Play. Tap **More details** →
   **Install anyway**.

### Installing on the Galaxy Z Flip

Same as above. Samsung phones show one extra prompt from **Auto Blocker** (One
UI 6.1 and newer), which blocks all sideloading:
Settings → **Security and privacy** → **Auto Blocker** → turn it off, or allow
this install specifically. Turn it back on afterwards if you like.

The Flip is worth testing specifically because of the fold: the manifest sets
`resizeableActivity` and handles `screenLayout` changes, so the app should
re-lay-out rather than restart when you unfold it. Please check that the study
view in `flashcards.html` survives a fold/unfold mid-session.

### Installing over USB (faster for repeat installs)

On the phone: Settings → About phone → tap **Build number** seven times to
unlock Developer options → Settings → System → Developer options → enable **USB
debugging**. Then, with the phone plugged in:

```bash
adb install -r app-debug.apk
```

### What to test first

- Both login paths — email/password, and Google (after steps 1–2).
- The top navigation bar: Android 15+ draws apps edge-to-edge under the status
  bar, and Capacitor is configured to inset the WebView (`adjustMarginsForEdgeToEdge`).
  Confirm the nav is not hidden behind the clock and battery icons.
- The **hardware/gesture Back** action. It should walk back through pages and
  only exit the app from the first one — not quit instantly. This is wired in
  `app-native.js`.
- The keyboard in `chat.html`: the manifest sets `adjustResize`, so the input
  should stay visible above the keyboard rather than being covered.
- Creating a flashcard stack, to confirm the Cloudflare Workers are reachable
  from the app's WebView origin.
- That **no Subscribe link or subscription page** is reachable anywhere in the
  app (see the store-payments note below).

---

## Step 4 — Publishing to Google Play

Only needed for a public release. Budget real calendar time for this: the
testing requirement below is the long pole, not the technical work.

### 4a. Developer account — $25, one time

Register at [play.google.com/console](https://play.google.com/console).

**The part that catches people out:** personal developer accounts created after
13 November 2023 must run a **closed test with at least 12 testers who stay
opted in continuously for 14 days** before you can even apply for production
access. Twelve real Google accounts, two solid weeks, before your first public
release — so start recruiting testers early.

An **organisation** account is exempt from the 12-tester rule, but requires a
D-U-N-S number for the business, which takes its own time to obtain. If
Lingonect is a registered business, the organisation route is usually faster
overall despite the extra paperwork.

### 4b. Create the release keystore

This key is what proves an update genuinely comes from you.

```bash
keytool -genkey -v -keystore ~/lingonect-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias lingonect
```

> **Back this file up somewhere you will not lose it** — a password manager and
> an offline copy. If you lose it you can never update the published app under
> the same listing again; you would have to publish a new one and lose your
> installs and reviews. Do **not** put it in the repo: `android/.gitignore`
> deliberately blocks `*.jks`, `*.keystore` and `keystore.properties`.

Then create `android/keystore.properties` (also gitignored):

```properties
storeFile=/absolute/path/to/lingonect-release.jks
storePassword=...
keyAlias=lingonect
keyPassword=...
```

`android/app/build.gradle` picks that file up automatically when it exists, and
skips release signing entirely when it does not — so nothing breaks for anyone
who just wants a debug build.

### 4c. Build the upload bundle

Play takes an `.aab`, not an `.apk`:

```bash
npm run android:bundle
# → android/app/build/outputs/bundle/release/app-release.aab
```

Bump `versionCode` (an integer, must increase on every single upload) and
`versionName` in `android/app/build.gradle` before each release.

### 4d. Store listing requirements

Have these ready — Play will not let you submit without them:

- **Privacy policy URL** — <https://www.lingonect.com/privacy.html> (already live).
- **Data safety form** — declare that the app collects email addresses and
  user-created flashcard content, and that data is sent to the AI translation
  providers. Answer this honestly; Play audits it and mismatches get apps pulled.
- **Content rating questionnaire.**
- **App icon** 512×512, **feature graphic** 1024×500, and at least two phone
  screenshots. Your Pixel and Flip can produce the screenshots directly.
- **Target audience and ads declaration.**

### 4e. Known blocker before submitting

`android/variables.gradle` currently targets **API 35** (Android 15). Play
requires new apps and updates to target the API level that became mandatory in
the most recent August cutoff, so **check the current requirement in Play
Console before your first upload**. Raising the target to API 36 also needs an
Android Gradle Plugin upgrade (`android/build.gradle` pins AGP 8.7.2, which
supports up to API 35), and API 36 tightens edge-to-edge enforcement further —
so it needs a real on-device pass, not just a green build. Worth doing as its
own change once you have the phones in hand.

---

## Store payment rules

`app-native.js` hides the subscription page, every Subscribe button and every
link to `subscription.html` inside **both** native apps, and redirects away from
the page if it is somehow reached. Apple Guideline 3.1.1 and Google Play's
Payments policy both require digital purchases to go through store billing and
both reject apps that merely link out to external payment.

The paid plan stays fully live on the website. If you later want to surface it
on Android — Google permits external payment links in more regions than Apple
does — the change is to make the stripping iOS-only in `app-native.js`, which
already tags the platform via the `native-android` / `native-ios` classes it
puts on `<html>`.

---

## Developing locally (optional)

You do not need this if you are happy downloading APKs from CI.

**Requirements:** [Android Studio](https://developer.android.com/studio) and a
JDK 21 (Android Studio bundles one).

```bash
npm install
npm run android        # copies web → www/, syncs Capacitor, opens Android Studio
```

Then press Run in Android Studio with a phone connected, or:

```bash
npm run android:run    # build and launch on a connected device
npm run android:apk    # just build android/app/build/outputs/apk/debug/app-debug.apk
```

**After any change to an HTML/CSS/JS file you must re-run `npm run sync`** —
the native project holds a *copy* of the web files under
`android/app/src/main/assets/public`, so edits to the root HTML files do not
appear in the app until they are copied across.

To debug the app's WebView, open `chrome://inspect` in desktop Chrome with the
phone connected over USB — you get the full DevTools console against the
running app.

### Regenerating icons and splash screens

Sources live in `assets/` (`icon.png` 1024×1024, `splash.png` and
`splash-dark.png` 2732×2732). After changing them:

```bash
npm run assets
```

---

## How the pieces fit together

```
  *.html, mobile.css, app-native.js, images      ← the single source of truth
                    │
                    │  scripts/copy-web.mjs   (plain file copy, no bundler)
                    ▼
                  www/                            ← gitignored, rebuilt each time
                    │
                    │  npx cap sync android
                    ▼
   android/app/src/main/assets/public/            ← gitignored, bundled into the APK
```

Key files:

| File | Purpose |
|------|---------|
| `capacitor.config.json` | App id, name, and the Android edge-to-edge setting |
| `app-native.js` | Native-only behaviour: back button, hiding subscription UI |
| `mobile.css` | Phone layout and safe-area (notch / status bar) handling |
| `android/app/build.gradle` | Package name, versions, debug + release signing |
| `android/variables.gradle` | min/compile/target SDK levels |
| `android/app/src/main/AndroidManifest.xml` | Permissions, foldable + keyboard behaviour |
| `.github/workflows/android.yml` | CI build producing the downloadable APK |
