import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const isFile = p => existsSync(p) && statSync(p).isFile();

function candidates(base) {
  const out = [base];
  if (base.endsWith('.js')) out.push(base.slice(0, -3) + '.ts');
  out.push(base + '.ts', path.join(base, 'index.ts'));
  return out;
}

export async function resolve(specifier, context, next) {
  // next's bare subpath imports only resolve under the bundler; tests load lib/auth.ts through books/api.ts.
  if (specifier === 'next/headers') return next('next/headers.js', context);
  let base = null;
  if (specifier.startsWith('@/')) base = path.join(ROOT, specifier.slice(2));
  else if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (base && !base.includes('node_modules')) {
    const hit = candidates(base).find(isFile);
    if (hit) return next(pathToFileURL(hit).href, context);
  }
  return next(specifier, context);
}
