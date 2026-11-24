// app-native.js — runtime adjustments that ONLY apply inside the native apps
// (iOS and Android, served from capacitor://localhost or https://localhost via
// Capacitor). The website is untouched.
//
// Store payment rules: App Store Guideline 3.1.1 and Google Play's Payments
// policy both require digital content to be sold through the store's own
// billing, and both reject apps that merely display a "Subscribe" button or an
// external payment/pricing page. Lingonect's paid plan is web-only (external),
// so inside the apps we present it as fully free: no subscription nav link, no
// Subscribe buttons, and the subscription page itself is not reachable. All of
// this stays live on the website.

(function () {
  var cap = window.Capacitor;
  var native = !!(cap
    && typeof cap.isNativePlatform === "function"
    && cap.isNativePlatform());
  if (!native) return;

  var platform = (typeof cap.getPlatform === "function" ? cap.getPlatform() : "");

  document.documentElement.classList.add("native-app");
  // Per-platform hook so CSS can target one store's app without the other.
  if (platform) document.documentElement.classList.add("native-" + platform);

  // If we somehow land on the subscription page inside the app, leave it.
  var path = (location.pathname || "").toLowerCase();
  if (path.indexOf("subscription") !== -1) {
    location.replace("engines.html");
    return;
  }

  // Remove every link that points at the subscription page (nav items and any
  // "Subscribe" call-to-action) so no purchase path is visible in the app.
  function stripSubscriptionUI() {
    var links = document.querySelectorAll('a[href*="subscription"]');
    for (var i = 0; i < links.length; i++) links[i].remove();
  }

  if (document.readyState !== "loading") stripSubscriptionUI();
  else document.addEventListener("DOMContentLoaded", stripSubscriptionUI);

  // ---- Android hardware / gesture back button ----
  // Lingonect is a multi-page app, so each nav is a real page load. Capacitor's
  // default back-button behaviour closes the app outright, which on Android
  // feels broken: users expect Back to walk back through the pages they came
  // from and only exit from the first one. Registering a listener replaces that
  // default, so we implement the expected behaviour ourselves.
  //
  // Note we talk to the plugin through Capacitor.addListener / nativePromise
  // rather than Capacitor.Plugins.App. Capacitor only fills in
  // Capacitor.Plugins for plugins whose JS wrapper has been imported and has
  // called registerPlugin(); the bridge injected into the WebView never
  // populates it. These pages load no bundled JS, so Capacitor.Plugins is
  // always empty here — but the lower-level bridge calls below work fine.
  if (platform === "android" && typeof cap.addListener === "function") {
    cap.addListener("App", "backButton", function (event) {
      // `canGoBack` comes from the native WebView's own history, which is more
      // reliable here than window.history.length.
      if (event && event.canGoBack) {
        window.history.back();
      } else {
        cap.nativePromise("App", "exitApp", {});
      }
    });
  }

  // ---- "Share to Lingonect" ----
  // Highlight text in any app (Safari, Chrome, Google, a PDF…), tap Share and
  // pick Lingonect: the text lands in the Engines input box, ready for the user
  // to choose what to do with it. On Android, the text-selection menu also
  // offers "Lingonect" directly (ACTION_PROCESS_TEXT).
  //
  // The native side turns every share into an internal link,
  //   com.lingonect.app://share?text=<text>&id=<unique id>
  // (iOS: ios/App/ShareExtension/ShareViewController.swift opens it;
  //  Android: MainActivity.java rewrites the share intent into it), so the
  // stock App plugin delivers it here as appUrlOpen / getLaunchUrl and no
  // custom plugin is needed.
  //
  // This is a multi-page app: every page load re-runs this file and
  // getLaunchUrl keeps returning the same launch link for the life of the app,
  // so each share's id is remembered and handled only once.
  var SHARE_PENDING_KEY = "lingonect-shared-text";
  var SHARE_SEEN_KEY = "lingonect-shared-ids";
  var SHARE_MAX_CHARS = 5000;

  function readStore(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* storage blocked: the share is simply dropped */ }
  }

  // Browsers often wrap a shared selection as  "the text"\nhttps://page#:~:text=…
  // (Chrome's link-to-highlight). Keep just the words the user highlighted.
  function cleanSharedText(text) {
    var t = String(text || "").replace(/\r\n?/g, "\n").trim();
    var lines = t.split("\n");
    if (lines.length > 1 && /^https?:\/\/\S+$/.test(lines[lines.length - 1].trim())) {
      lines.pop();
      t = lines.join("\n").trim();
      var quoted = t.match(/^["“„«](.*)["”“»]$/);
      if (quoted) t = quoted[1].trim();
    }
    return t.slice(0, SHARE_MAX_CHARS);
  }

  function receiveShareUrl(url) {
    if (typeof url !== "string" || !/^com\.lingonect\.app:\/\/share\b/i.test(url)) return;
    var query = url.split("?")[1] || "";
    var params;
    try { params = new URLSearchParams(query.split("#")[0]); } catch (e) { return; }
    var text = cleanSharedText(params.get("text"));
    var id = params.get("id") || "";
    if (!text) return;

    var seen = [];
    try { seen = JSON.parse(readStore(SHARE_SEEN_KEY) || "[]") || []; } catch (e) { seen = []; }
    if (id && seen.indexOf(id) !== -1) return;  // already handled on an earlier page
    if (id) {
      seen.push(id);
      writeStore(SHARE_SEEN_KEY, JSON.stringify(seen.slice(-20)));
    }

    writeStore(SHARE_PENDING_KEY, text);
    if (/engines\.html$/i.test(location.pathname || "")) fillSharedText();
    else location.href = "engines.html";
  }

  // On the Engines page, move a pending share into the input box. Set it the
  // way typing would, so the word counter, Submit button and language
  // auto-detection react (same as setInputText() in engines.html).
  function fillSharedText() {
    var input = document.getElementById("inputText");
    var text = readStore(SHARE_PENDING_KEY);
    if (!input || !text) return;
    writeStore(SHARE_PENDING_KEY, null);
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    try { input.scrollIntoView({ block: "center" }); } catch (e) { /* old WebView */ }
  }

  if (/engines\.html$/i.test(location.pathname || "")) {
    if (document.readyState !== "loading") fillSharedText();
    else document.addEventListener("DOMContentLoaded", fillSharedText);
  }

  if (typeof cap.addListener === "function") {
    cap.addListener("App", "appUrlOpen", function (event) {
      receiveShareUrl(event && event.url);
    });
  }
  if (typeof cap.nativePromise === "function") {
    cap.nativePromise("App", "getLaunchUrl", {}).then(function (res) {
      receiveShareUrl(res && res.url);
    }, function () { /* no launch URL */ });
  }
})();
