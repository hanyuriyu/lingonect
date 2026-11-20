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

> **It must be `android/app/`, not `android/`.** Gradle looks for the file in
> the *module* directory (`android/app/`), which is what the arrow in Firebase's
> "move it into your module (app-level) root directory" diagram points at. Put
> it one level up in `android/` and nothing complains: the build still succeeds,
> the google-services plugin just silently never applies, and Google Sign-In
> keeps failing with no clue why.

> **The SHA-1 fingerprint is not optional.** Firebase lets you register the app
> without one, and the resulting `google-services.json` looks perfectly normal —
> but it will contain only a web `oauth_client` (`client_type: 3`) and no
> Android one (`client_type: 1` with a `certificate_hash`). Google Sign-In then
> fails on the device with `ApiException: 10` (DEVELOPER_ERROR), because Google
> cannot verify which app is calling. If you already registered without it: add
> the fingerprint under Project settings → Your apps → the Android app → **Add
> fingerprint**, then **download `google-services.json` again** — the file only
> gains the Android client once a fingerprint exists.

To check a file you have already downloaded:

```bash
python3 -c "import json;print([c['client_type'] for c in json.load(open('android/app/google-services.json'))['client'][0]['oauth_client']])"
```

`[1, 3]` is what you want. `[3]` alone means the fingerprint is missing.

If you would rather not commit it, add its **contents** as a repository secret
named `GOOGLE_SERVICES_JSON` (GitHub → Settings → Secrets and variables →
Actions) instead; the workflow writes it out at build time either way.

Without this file the app still builds and runs — you just get email/password
login, and the Google button reports that sign-in is unavailable.

## Step 3 — Get the app onto your phones

### Getting the APK

Every push to `main` publishes the build to a **GitHub Release under a fixed
tag**, so there is one permanent link that always serves the newest build:

> **<https://github.com/hanyuriyu/lingonect/releases/download/android-latest/lingonect.apk>**

Open that link **directly in the browser on the phone** and it downloads the APK
ready to install — no GitHub login, no zip to unpack, and it never expires.
Bookmark it on both devices; the URL does not change between builds.

The release page itself, which shows which commit the build came from, is at
<https://github.com/hanyuriyu/lingonect/releases/tag/android-latest>.

Each build is stamped with a version like `1.0.7-a1b2c3d` (run number and
commit), visible on the phone under Settings → Apps → Lingonect. Check it to
confirm you are testing the build you think you are.

> Because the repository is public, so is this download link. If you would
> rather test builds not be publicly downloadable, use the workflow artifacts
> below instead and the release step can be dropped.

**Builds from branches and pull requests** do not touch that link. They are
attached to the workflow run as an artifact instead: GitHub → **Actions** → the
run → scroll to the bottom → **Artifacts** → `lingonect-debug-<sha>.zip`.
Downloading an artifact requires being signed in to GitHub, and it arrives as a
zip, which is why `main` builds go to a Release instead.

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

### 4b. Create the upload key

With **Play App Signing** (on by default for new apps) Google holds the real app
signing key and you sign uploads with a separate *upload key*. That matters: if
an upload key is lost or leaked, Google can reset it. Losing the app signing key
used to mean never updating the app again; Play App Signing removes that cliff.

Create the upload key:

```bash
keytool -genkey -v -keystore lingonect-upload.keystore \
  -keyalg RSA -keysize 2048 -validity 10000 -alias lingonect
```

Keep it in a password manager and an offline copy anyway — resetting is a
support round-trip, not a button. Never commit it: `android/.gitignore` blocks
`*.jks`, `*.keystore` and `keystore.properties`.

### 4c. Build the signed bundle

Play takes an `.aab`, not an `.apk`, and rejects a debug-signed upload. The
release signing config reads from **environment variables first, then
`android/keystore.properties`**, so the same build works in CI and locally.

**In CI (release from your phone).** Add four repository secrets under
Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 lingonect-upload.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `lingonect` |
| `ANDROID_KEY_PASSWORD` | the key password |

The `release-aab` job stays inert until `ANDROID_KEYSTORE_BASE64` exists, so it
costs nothing before then and switches itself on once the secret is added. It
writes the keystore outside the repo, builds, checks the bundle is not
debug-signed, uploads the `.aab` as a build artifact, and deletes the keystore
again. Download the artifact and upload it to Play Console.

**Locally.** Create `android/keystore.properties` (gitignored):

```properties
storeFile=/absolute/path/to/lingonect-upload.keystore
storePassword=...
keyAlias=lingonect
keyPassword=...
```

then `npm run android:bundle`.

**versionCode must increase on every upload** and Play never accepts the same
one twice. CI uses the workflow run number, which is monotonic. Building locally
uses 1 unless you set `ANDROID_VERSION_CODE`, so prefer CI for anything you
actually upload.

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

### 4e. Target API level

Google Play requires **new apps and updates to target Android 16 (API 36)** as
of 31 August 2026; the extension window closed on 1 November 2026. An upload
targeting a lower level is rejected.

`android/variables.gradle` therefore sets `compileSdkVersion` and
`targetSdkVersion` to 36, which also required moving `android/build.gradle` from
Android Gradle Plugin 8.7.2 (capped at API 35) to 8.10.1. The Gradle wrapper
stays at 8.11.1, which is the minimum AGP 8.10 accepts.

API 36 enforces edge-to-edge display with no opt-out, so the top navigation and
safe-area handling are worth re-checking on a device after any change here — a
green build does not prove the layout is right. Capacitor's
`adjustMarginsForEdgeToEdge` setting in `capacitor.config.json` is what insets
the WebView.

Check the current requirement in Play Console before each release; the cutoff
moves every August.

---

## Going live: closed testing checklist

Follow in order. Steps 1 and 2 are gated on Google, so start them first; the
rest can be done while you wait.

### 1. Register — <https://play.google.com/console/signup>

$25, one time, non-refundable. Watch out for:

- **Identity verification is now required.** Expect to supply a government ID
  and have it checked. This takes days, so it is the first thing to start.
- **Use an account you will still control in five years.** The signup Google
  account becomes the owner and moving it later is painful. Not a throwaway.
- **The developer name is public.** Pick "Lingonect", not your own name. For
  personal accounts Google may also publish your contact address on the
  listing — if that is not acceptable, it is an argument for an organisation
  account later.
- **$25 buys the account, not the app.** There is no per-app fee.

### 2. Create the app, keep Play App Signing on

- App name, default language, free, and a handful of declarations.
- **Leave Play App Signing enabled** (the default). Google then holds the real
  signing key and you sign uploads with a resettable upload key. Opting out
  re-creates the old "lose the key, never update the app again" cliff.
- **`com.lingonect.app` is permanent.** A package name can never be changed
  once published, and it is already baked into Firebase and the signing setup.

### 3. App content declarations

Required before a closed-track release reaches anyone. Privacy policy URL is
already live at <https://www.lingonect.com/privacy.html>.

Answers below are derived from the code, not guessed. Play audits this and
mismatches get apps pulled, so change them if the app changes.

**Does the app collect or share user data?** Yes.

| Data type | Collected | Shared | Why |
|---|---|---|---|
| Email address | Yes | No | Firebase Auth account |
| Name / username | Yes | No | `profiles`, `usernames` |
| User IDs | Yes | No | Firebase UID |
| Messages | Yes | No | in-app chat, `chats/{room}/messages` |
| Photos | Yes | **Yes** | camera text capture is sent to the AI workers |
| Other user content | Yes | **Yes** | flashcards, `history`, text sent for translation |
| App activity | Yes | No | `ratings`, `triangulationWins`, study history |

- **"Shared" is the one people get wrong.** Under Play's definition, data is
  shared when it is transferred to a third party. Text and photos sent to the
  Cloudflare Workers reach Anthropic, OpenAI, Google, DeepSeek and the other
  engines, so those rows are shared, even though Lingonect runs the proxy.
- **Photos count as collected even though none are stored.** Play counts data
  as collected once it leaves the device; the capture is held in memory and
  dropped, but it is transmitted, so it is declared.
- **No analytics, advertising or tracking SDKs**, so no advertising ID, no
  location, no contacts, no financial data. Answer "No" to ads.
- Data is encrypted in transit (HTTPS throughout) and users can delete their
  account, so answer yes to both.

Also complete: content rating questionnaire, target audience, app access (give
Google test credentials, since the app is behind a login — otherwise review
cannot see past the sign-in screen and will reject it).

### 4. Add the signing secrets

Create the upload key and add the four secrets per §4b–4c. CI then builds the
signed `.aab` on every push to `main` and attaches it as a build artifact.

### 5. Closed testing track

- Upload the `.aab`, add testers by email or Google Group, share the opt-in
  link. No minimum to start.
- **The first review on a new account can take several days.** Internal testing
  skips review entirely, so add an internal track too if you want a fast lane
  while iterating.
- For production later: **12 testers opted in continuously for 14 days**, then
  apply. Run 14–15 for slack; one dropping out restarts the clock.
- **Do not put those 12 in the internal track as well.** A tester in several
  tracks is served the highest-priority one (internal beats closed), so their
  activity would land on the wrong track.

---

## Camera capture

The camera button in the engines page input box uses a plain file input with
`capture="environment"`. On iOS that is enough. On Android it is not: Capacitor
resolves `ACTION_IMAGE_CAPTURE` before launching the camera, and since Android
11 package visibility filtering hides every other app from `resolveActivity()`
unless the manifest declares a `<queries>` element for that intent. Without it
Capacitor concludes the device has no camera app and quietly falls back to the
gallery picker — the button appears to work, it just opens the wrong thing.

So `AndroidManifest.xml` declares:

```xml
<queries>
    <intent>
        <action android:name="android.media.action.IMAGE_CAPTURE" />
    </intent>
</queries>
```

Note there is deliberately **no** `CAMERA` permission. `ACTION_IMAGE_CAPTURE`
hands off to the camera app, which holds its own permission. Declaring `CAMERA`
here would flip Capacitor's `isMediaCaptureSupported()` check and make it demand
a runtime grant the app does not otherwise need.

Capacitor writes the photo to `getExternalFilesDir(PICTURES)`, so
`res/xml/file_paths.xml` maps `external-files-path` as well. If FileProvider
cannot resolve that path the capture intent is never launched and you land back
in the gallery, which makes the two failures look identical from the phone.

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
