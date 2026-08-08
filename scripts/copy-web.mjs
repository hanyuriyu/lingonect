// Copies the web app (HTML / CSS / images) into www/ so Capacitor can bundle
// it into the native iOS app. This is NOT a bundler — just a plain file copy
// with a denylist, keeping the project's "no build step" convention intact.
//
// Run via:  npm run copy-web   (or automatically via  npm run sync / npm run ios)

import { cp, rm, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'www');

// Everything NOT in this set gets copied into www/. This captures all the
// .html pages, mobile.css, favicons, logos and other images automatically.
const DENY = new Set([
  '.git', '.github', 'node_modules', 'www', 'ios', 'android', 'scripts',
  'workers', 'test-results', '.claude', 'assets',
  'package.json', 'package-lock.json', 'capacitor.config.json',
  'CLAUDE.md', 'CNAME', 'firebase.json', 'firebase-rtdb-rules.json',
  'firestore.rules', 'firestore.indexes.json', 'robots.txt', 'sitemap.xml',
  '.gitignore', '.DS_Store',
]);

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

const entries = await readdir(root, { withFileTypes: true });
let count = 0;
for (const e of entries) {
  if (DENY.has(e.name)) continue;
  await cp(join(root, e.name), join(dest, e.name), { recursive: true });
  count++;
}

console.log(`Copied ${count} web items into www/`);
