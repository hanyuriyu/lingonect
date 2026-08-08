// app-native.js — runtime adjustments that ONLY apply inside the native iOS app
// (served from capacitor://localhost via Capacitor). The website is untouched.
//
// App Store Guideline 3.1.1 forbids selling digital content through anything
// but Apple In-App Purchase, and Apple rejects apps that merely display a
// "Subscribe" button or external-payment/pricing page. Lingonect's paid plan
// is web-only (external), so inside the app we present it as fully free: no
// subscription nav link, no Subscribe buttons, and the subscription page itself
// is not reachable. All of this stays live on the website.

(function () {
  var native = !!(window.Capacitor
    && typeof window.Capacitor.isNativePlatform === "function"
    && window.Capacitor.isNativePlatform());
  if (!native) return;

  document.documentElement.classList.add("native-app");

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
})();
