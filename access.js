// Lingonect invite-only access, shared by every members-only page.
//
// Sign-in stays open (Google / Apple / email), because the native apps need
// it for App Store / Play review, but an account only gets in once it is
// approved. Approval lives in accessRequests/{uid}, which only the account
// itself and the admin can read and only the admin can change (see
// firestore.rules), so emails never land in the public profiles directory.
//
// Who is approved:
//   - the admin account
//   - accessRequests/{uid}.status == "approved"  (set on the Admin page)
//   - Pro subscribers (profile plan "pro" / subscribed)
//   - every account that existed before APPROVAL_CUTOFF_MS, unless the admin
//     set accessRequests/{uid}.status == "revoked"
//
// Website: an unapproved account sees the invite-only screen.
// Native apps: an unapproved account keeps the free tier (the same three
// engines as anonymous use), so signing in is never a dead end for review.
(function () {
  const ADMIN_EMAIL = "linguisticsconsulting@gmail.com";
  const CONTACT_EMAIL = "contact@lingonect.com";
  // Accounts created before this instant keep their access (go-live of the
  // invite-only gate). Everyone created later needs approval.
  const APPROVAL_CUTOFF_MS = Date.parse("2026-11-22T20:00:00Z");

  function isNativeApp() {
    return !!(window.Capacitor
      && typeof window.Capacitor.isNativePlatform === "function"
      && window.Capacitor.isNativePlatform());
  }

  function decide(user, request, profile) {
    if (!user || user.isAnonymous) return false;
    if (user.email === ADMIN_EMAIL) return true;
    const status = request && request.status;
    if (status === "approved") return true;
    if (status === "revoked") return false;
    if (profile && (profile.plan === "pro" || profile.subscribed === true)) return true;
    const created = Date.parse(user.metadata && user.metadata.creationTime);
    return !!created && created < APPROVAL_CUTOFF_MS;
  }

  // Reads the account's access request (and profile unless one is passed),
  // records a "waiting" request the first time an unapproved account shows
  // up, and returns { approved, request, profile }. Never throws: a read
  // failure falls back to the account-age rule.
  async function check(user, db, profile) {
    let request = null;
    try {
      const reqRef = db.collection("accessRequests").doc(user.uid);
      const [reqSnap, profSnap] = await Promise.all([
        reqRef.get(),
        profile === undefined ? db.collection("profiles").doc(user.uid).get() : null
      ]);
      request = reqSnap.exists ? reqSnap.data() : null;
      if (profSnap) profile = profSnap.exists ? profSnap.data() : null;
      const approved = decide(user, request, profile);
      if (!approved && !request && user.email !== ADMIN_EMAIL) {
        request = {
          status: "waiting",
          email: user.email || "",
          name: user.displayName || "",
          provider: (user.providerData[0] && user.providerData[0].providerId) || "password",
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        await reqRef.set(request).catch(e => console.warn("access request not recorded:", e));
      }
      return { approved, request, profile: profile || null };
    } catch (e) {
      console.warn("access check failed, using account age:", e);
      return { approved: decide(user, request, profile), request, profile: profile || null };
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Full-page invite-only screen (website). Covers the page, offers sign out.
  function showInviteOnly(user, auth) {
    const email = (user && user.email) || "";
    const subject = encodeURIComponent("Access request");
    const body = encodeURIComponent("Hello Lingonect,\n\nI'd like to request access.\nAccount: " + email + "\n\nA little about me:\n");
    const el = document.createElement("div");
    el.id = "inviteOnlyScreen";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.style.cssText = "position:fixed;inset:0;z-index:99999;background:#fff;color:#111;display:flex;"
      + "align-items:center;justify-content:center;padding:24px;box-sizing:border-box;overflow:auto;"
      + "font-family:'Special Elite','Courier New',monospace;";
    el.innerHTML =
      '<div style="max-width:520px;text-align:center;line-height:1.6">'
      + '<img src="logo.png" alt="Lingonect" style="width:120px;height:120px;object-fit:contain;opacity:.9">'
      + '<h1 style="font-size:24px;margin:16px 0 8px">Lingonect is invite-only for now, and free.</h1>'
      + '<p style="margin:0 0 16px">You\'re signed in as <strong>' + esc(email || "this account") + '</strong>, '
      + 'but this account doesn\'t have access yet.</p>'
      + '<p style="margin:0 0 20px">To request it, email <a style="color:#0047FF" href="mailto:' + CONTACT_EMAIL
      + '?subject=' + subject + '&body=' + body + '">' + CONTACT_EMAIL + '</a> from this address '
      + '(or include it in your message) and tell us a little about yourself. We approve people case by case.</p>'
      + '<p style="margin:0 0 24px"><a style="display:inline-block;background:#0047FF;color:#fff;padding:10px 18px;'
      + 'border-radius:6px;text-decoration:none" href="mailto:' + CONTACT_EMAIL + '?subject=' + subject + '&body=' + body
      + '">Request access</a></p>'
      + '<p style="font-size:14px;color:#555;margin:0">'
      + '<a href="index.html" style="color:#555">Home</a> &nbsp;·&nbsp; '
      + '<a href="#" id="inviteSignOut" style="color:#555">Sign out</a> &nbsp;·&nbsp; '
      + '<a href="profile.html" style="color:#555">Delete my account</a></p>'
      + '</div>';
    document.body.appendChild(el);
    document.body.style.visibility = "visible";
    const out = el.querySelector("#inviteSignOut");
    out.addEventListener("click", e => {
      e.preventDefault();
      (auth || firebase.auth()).signOut().then(() => { window.location.href = "index.html"; });
    });
  }

  // Small dismissible note for the native free tier.
  function showAppNote() {
    if (document.getElementById("inviteOnlyNote")) return;
    const el = document.createElement("div");
    el.id = "inviteOnlyNote";
    el.style.cssText = "margin:12px auto;max-width:640px;padding:10px 14px;border:1px solid #0047FF;"
      + "border-radius:6px;font-size:14px;line-height:1.5;color:#111;background:#f4f7ff;text-align:center;";
    el.innerHTML = 'You\'re using the free engines. Lingonect is invite-only for now: to request full access, '
      + 'email <a style="color:#0047FF" href="mailto:' + CONTACT_EMAIL + '">' + CONTACT_EMAIL + '</a>.';
    const target = document.querySelector(".page-wrap, main, .stage") || document.body;
    target.insertBefore(el, target.firstChild);
  }

  // One call for the members-only pages other than Engines: website → invite
  // screen; app → back to Engines (free tier). Returns true when approved.
  async function guardPage(user, db, auth) {
    const res = await check(user, db);
    if (res.approved) return true;
    if (isNativeApp()) window.location.href = "engines.html";
    else showInviteOnly(user, auth);
    return false;
  }

  window.LingonectAccess = { check, decide, guardPage, showInviteOnly, showAppNote, isNativeApp,
    APPROVAL_CUTOFF_MS, CONTACT_EMAIL };
})();
