import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// .dev.vars.example is the only list of what this Worker can be configured
// with, and an unset ISBNNET_RESOLVER_SECRET fails nothing: lookups simply stay open.
// Same check as CFEdgeChat's: every string field of `interface Env` is listed.
const ROOT = path.join(__dirname, '..');
const EXAMPLE = fs.readFileSync(path.join(ROOT, '.dev.vars.example'), 'utf-8');
const INDEX = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf-8');

const envBlock = INDEX.match(/interface Env\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
const stringVars = [...envBlock.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:\s*string;/gm)].map(m => m[1]).sort();
const declaredKeys = [...EXAMPLE.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m => m[1]).sort();

describe('.dev.vars.example', () => {
  it('finds the Env declaration, so the check below means something', () => {
    expect(stringVars).toContain('ISBNNET_RESOLVER_SECRET');
  });

  it('lists exactly the variables the Worker reads', () => {
    expect(declaredKeys).toEqual(stringVars);
  });

  it('holds key names only, no values', () => {
    expect(EXAMPLE).not.toMatch(/^[A-Za-z_][A-Za-z0-9_]*=\S/m);
  });
});
