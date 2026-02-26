#!/usr/bin/env node
/**
 * Copies vendored browser assets from node_modules into src/web/public/vendor/
 * so they can be served as static files without a bundler step.
 */

import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dest = join(root, 'src', 'web', 'public', 'vendor');

mkdirSync(dest, { recursive: true });

const copies = [
  ['node_modules/htmx.org/dist/htmx.min.js', 'htmx.min.js'],
  ['node_modules/htmx-ext-sse/sse.js', 'htmx-ext-sse.js'],
  ['node_modules/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

for (const [src, name] of copies) {
  const srcPath = join(root, src);
  const destPath = join(dest, name);
  cpSync(srcPath, destPath);
  console.log(`  copied ${src} → src/web/public/vendor/${name}`);
}

console.log('vendor-assets: done');
