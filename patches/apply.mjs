#!/usr/bin/env node
// Applies maintained dependency patches under patches/<dir>/*.patch.
// Format: unified-diff-like; target taken from the '--- a/' header;
// '+' lines carry the guarded insertion. Run after every npm install. Idempotent.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let applied = 0, skipped = 0;
for (const dir of readdirSync(join(root, 'patches'))) {
  const d = join(root, 'patches', dir);
  if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d).filter((f) => f.endsWith('.patch'))) {
    const text = readFileSync(join(d, f), 'utf8');
    const header = text.split('\n').find((l) => l.startsWith('--- a/'));
    if (!header) throw new Error(`no --- a/ header in ${f}`);
    const rel = header.replace(/^--- a\//, '').split(' ')[0].replace(/^node_modules\//, '');
    const plus = text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    const guard = plus.find((l) => l.trim().startsWith('if (!this.parser) return;'));
    const marker = plus.find((l) => l.includes('OPENCLAW PATCH'));
    if (!guard || !marker) throw new Error(`malformed patch ${f}`);
    const anchor = '_onData(data) {';
    const p = join(root, 'node_modules', rel);
    let src = readFileSync(p, 'utf8');
    if (src.includes(guard.trim())) { skipped++; continue; }
    if (!src.includes(anchor) || !src.includes('this.parser.write(str);')) {
      throw new Error(`anchor not found in ${rel}; upstream changed — review ${f}`);
    }
    src = src.replace(anchor, anchor + '\n' + plus.join('\n'));
    writeFileSync(p, src);
    applied++;
  }
}
console.log(`patches applied=${applied} already-present=${skipped}`);
