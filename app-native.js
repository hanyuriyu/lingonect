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
  if (platform === "android") {
    var App = cap.Plugins && cap.Plugins.App;
    if (App && typeof App.addListener === "function") {
      App.addListener("backButton", function (event) {
        // `canGoBack` comes from the native WebView's own history, which is more
        // reliable here than window.history.length.
        if (event && event.canGoBack) {
          window.history.back();
        } else if (typeof App.exitApp === "function") {
          App.exitApp();
        }
      });
    }
  }
})();
