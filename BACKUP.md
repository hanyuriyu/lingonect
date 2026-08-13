# Backup & Disaster-Recovery Strategy

Lingonect's code and website currently live entirely on **GitHub** (source in
`hanyuriyu/lingonect`, site served via GitHub Pages at `www.lingonect.com`).
This document sets up an **independent backup mirror on GitLab** so that if
GitHub ever has an outage — or we lose access to the account — we still have a
complete, self-sufficient copy of the project on unrelated infrastructure.

Because git is *distributed*, the full history already exists in every clone.
The goal here is to make sure a **second remote host** always has an up-to-date
copy, so recovery is a matter of minutes, not a rebuild from memory.

---

## 1. Why GitLab

GitLab.com is a separate company from GitHub (Microsoft), with its own
infrastructure. It is free, closely matches GitHub's features, and — usefully —
offers **GitLab Pages**, so it can host a fallback copy of the static site too,
not just the code. (Codeberg is an equally good, more community-run
alternative if you'd prefer a non-profit; the steps below are nearly identical.)

---

## 2. One-time setup

### Step A — Create the empty backup repo on GitLab

1. Sign up / log in at <https://gitlab.com> (free account).
2. Click **New project → Create blank project**.
3. Project name: `lingonect`.
4. **Important:** leave "Initialize repository with a README" **unchecked** —
   it must start empty so the push below doesn't conflict.
5. Set visibility to whatever matches GitHub (Public or Private).
6. Click **Create project**, then copy its clone URL, e.g.
   `https://gitlab.com/<your-username>/lingonect.git`.

### Step B — Wire up dual-push on your machine

From inside your local `lingonect` clone, run the helper script with your new
GitLab URL:

```bash
scripts/setup-backup-mirror.sh https://gitlab.com/<your-username>/lingonect.git
```

This:

- adds a `backup` remote pointing at GitLab, and
- configures the existing `origin` so that **one `git push` sends to GitHub
  AND GitLab at the same time**.

### Step C — Seed the mirror with everything

```bash
git push backup --all
git push backup --tags
```

Now GitLab holds every branch and tag. Confirm with `git remote -v` — you
should see `origin` listing **two** `(push)` URLs (github + gitlab).

---

## 3. Day-to-day use

Nothing changes in your workflow. Just push as normal:

```bash
git push
```

Every push now lands on **both** GitHub and GitLab automatically. If one host
is down, the push to the other still succeeds (git reports the failed one but
completes the reachable one).

> **Note on Claude Code web / cloud sessions:** git config lives inside each
> clone, and cloud session containers are ephemeral, so the dual-push config
> does **not** persist between web sessions. In those sessions, either re-run
> `scripts/setup-backup-mirror.sh` first, or rely on the **scheduled mirror**
> below, which needs no local config at all.

---

## 4. Optional: fully automatic, zero-effort mirroring

If you'd rather never think about it, GitLab can **pull from GitHub on a
schedule** so it stays in sync no matter where you push from:

1. In your GitLab project: **Settings → Repository → Mirroring repositories**.
2. Git repository URL: `https://github.com/hanyuriyu/lingonect.git`
3. Mirror direction: **Pull**.
4. Authentication: **Password** — use a GitHub
   [personal access token](https://github.com/settings/tokens) with `repo`
   scope as the password (only needed if the GitHub repo is private; public
   repos need no token).
5. Save. GitLab will now re-pull GitHub periodically and after manual triggers.

With this on, GitLab mirrors GitHub automatically even from cloud sessions.

---

## 5. Optional: back up the live website too

GitHub Pages serves `www.lingonect.com` today. To have a hosting fallback:

- Enable **GitLab Pages** on the mirror (GitLab auto-detects static sites; this
  repo is plain HTML so no build step is needed).
- Keep the domain's DNS records documented so `www.lingonect.com` can be
  repointed to GitLab Pages if GitHub Pages is unavailable.

This is optional — the code backup (sections 2–3) is the essential part; the
site can always be re-deployed from it.

---

## 6. If GitHub is down — recovery

1. Clone from the mirror: `git clone https://gitlab.com/<username>/lingonect.git`
2. Continue working; push to GitLab.
3. If needed, enable GitLab Pages (section 5) and repoint DNS to restore the
   live site.
4. When GitHub returns, `git push origin` re-syncs it.

Because both hosts hold the complete history, no work is ever lost as long as
at least one of them is reachable.
