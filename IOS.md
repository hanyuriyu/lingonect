# Lingonect for iPhone

The iOS app is a [Capacitor](https://capacitorjs.com) wrapper around the *same*
web pages the website serves — exactly like the Android app. There is no
separate iOS codebase. `ios/App/App/public/` is a **copy** of the root `.html`
files, regenerated on every build.

Unlike Android, **iOS needs a Mac.** Xcode does not run anywhere else, there is
no CI path for it in this repo (`.github/workflows/` builds Android and the
workers only), and the Apple Developer Program costs $99/year rather than
Android's one-off $25. So every iPhone release is a manual job on one machine.

The Xcode project lives in `ios/` and **is committed**, the same way `android/`
is. It was not, for months, while `.gitignore` claimed otherwise; the project,
its signing configuration and `GoogleService-Info.plist` existed on exactly one
laptop. Keep it committed.

---

## The one rule that catches everyone

**The app does not load the website. It bundles a copy of it.**

`capacitor.config.json` sets `webDir: "www"` and deliberately has no
`server.url`, so the pages are baked into the `.ipa` at build time. A change
pushed to the website — even one live at www.lingonect.com — reaches the app
only after a rebuild *and* an App Store release.

That is what `npm run sync` is for, and why skipping it silently ships stale
content:

```
root *.html  →  scripts/copy-web.mjs  →  www/  →  cap sync  →  ios/App/App/public/
```

Both `www/` and `ios/App/App/public/` are gitignored and regenerated. Never
edit either by hand — your change will vanish on the next sync.

---

## Releasing, in order

### Step 1 — Sync the web app

```bash
npm install          # only needed after a fresh clone or a dependency change
npm run ios          # copy-web → cap sync → pod install → opens Xcode
```

`npm run ios` is the whole preflight. If you open Xcode any other way, run
`npm run sync` first or you will archive whatever `public/` last held.

`cap sync` shells out to CocoaPods, so `pod --version` must answer. Pod
versions are pinned by `ios/App/Podfile.lock`, which is committed on purpose.

### Step 2 — Bump the version and build number

App Store Connect rejects an upload whose build number it has seen before, so
this is mandatory, not housekeeping.

The values are **not literals** in `Info.plist` — it holds
`$(MARKETING_VERSION)` and `$(CURRENT_PROJECT_VERSION)`, which resolve from the
Xcode project's build settings. Two ways to change them:

*In Xcode:* click the blue **App** project row at the top of the navigator (the
row itself, not its disclosure triangle) → **App** under **TARGETS** →
**General** → **Identity** → the **Version** and **Build** fields.

*Or from the terminal, with Xcode closed* (it holds the project in memory and
will overwrite edits made behind its back):

```bash
grep -nE 'MARKETING_VERSION|CURRENT_PROJECT_VERSION' ios/App/App.xcodeproj/project.pbxproj
```

Each appears twice — once for Debug, once for Release. Change both.

The rules:

- **Build** must increase for every upload, always.
- **Version** must increase if the current version is already live on the App
  Store. Bumping only the build number is not enough for a new release.

Commit the bump. `ios/` is tracked, so it belongs in the history.

### Step 3 — Archive

Set the destination to **Any iOS Device (arm64)**. Archive is greyed out while
a simulator is selected, which is the usual reason people think it is broken.

**Product → Archive**, then in the Organizer window that opens:
**Distribute App → App Store Connect → Upload**.

### Step 4 — What to test before you upload

Run it on a real device first (`▶` with your iPhone selected). The app is a
WebView, so a broken page is a broken app, and a review rejection costs days
where a rebuild costs minutes.

The two that get apps **rejected**:

- **Sign in with Apple** — Guideline 4.8 requires an equivalent
  privacy-preserving login option wherever a third-party one (Google) is
  offered. Both live on `login.html`.
- **Account deletion** — Guideline 5.1.1(v) requires deleting the account from
  *inside* the app, not via a support email. It is on `profile.html`.

The ones that merely embarrass you:

- **Google sign-in.** This broke once already, in a way no test caught: the
  code checked `window.Capacitor.Plugins.FirebaseAuthentication`, but Capacitor
  only populates `Capacitor.Plugins` for plugins whose JS wrapper was imported
  and called `registerPlugin()`. These pages load no bundled JS, so that object
  is permanently empty and sign-in failed with *"the FirebaseAuthentication
  plugin is not installed"* on every build for weeks. Calls now go through
  `Capacitor.nativePromise` instead — see `login.html` and `app-native.js`. If
  you ever see that message again, this is why.
- **The landing page animation**, which has been fixed more than once and is
  sensitive to browser chrome and safe-area insets.
- **The free tier**: signed out, the nav should show only About, Engines and
  Login.

---

## Firebase

`ios/App/App/GoogleService-Info.plist` is committed, matching
`android/app/google-services.json`. The identifiers in it are not secrets —
they ship inside every copy of the app and can be read out of any installation.
Access control is enforced by `firebase-rtdb-rules.json` and `firestore.rules`.

What must **never** be committed: `serviceAccount.json` (the Firebase Admin
private key — full database access, bypasses the rules entirely) and any
release signing material.

---

## Store payment rules

App Store Guideline 3.1.1 requires digital content to be sold through Apple's
own billing and rejects apps that merely *display* a Subscribe button or an
external pricing page. Lingonect's paid plan is web-only, so `app-native.js`
strips every subscription link inside the app and redirects away from
`subscription.html`. The website is untouched.

Google Play's Payments policy says the same thing, which is why the stripping
is not iOS-specific. Leave it in place unless someone has decided to implement
StoreKit.

---

## How the pieces fit together

```
root *.html, mobile.css, images     the single source of truth
  │
  ├─ GitHub Pages ──────────────►   www.lingonect.com (live immediately)
  │
  └─ scripts/copy-web.mjs
        │
        └─ www/  ──  npx cap sync  ──┬─► ios/App/App/public/      → Xcode  → App Store
                                     └─► android/…/assets/public/ → Gradle → Play Store
```

The website updates the moment you push. **The apps do not.** Each one needs a
rebuild and a store release, which is why web changes can sit unshipped in the
apps for weeks without anyone noticing.

Android setup, signing and Play Store steps live in `ANDROID.md`. Backup and
mirror arrangements live in `BACKUP.md`.
