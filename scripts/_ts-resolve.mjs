// Let the verification scripts import the app's TypeScript modules unchanged.
//
// App code uses extensionless relative imports ('../db/migrations') because that
// is what TypeScript and Metro expect. Node's ESM resolver requires a real file
// extension, so importing a .ts module that itself imports a sibling would fail.
// This registers a resolve hook that retries with '.ts' (then '/index.ts').
//
// The shim lives ONLY in scripts/: the point of these verifications is to run the
// app's real modules, so the app must not be contorted to suit the test runner.
//
// Usage — the hook must be registered BEFORE the module graph is linked, so the
// importing script has to load the module dynamically:
//     import './_ts-resolve.mjs';
//     const mod = await import('../src/roster/labels.ts');

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tryUrl = (specifier, parentURL, suffix) => {
  try {
    const url = new URL(specifier + suffix, parentURL);
    return existsSync(fileURLToPath(url)) ? url.href : null;
  } catch {
    return null;
  }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.ts', '.tsx', '/index.ts']) {
          const url = tryUrl(specifier, context.parentURL, suffix);
          if (url) return { url, format: 'module-typescript', shortCircuit: true };
        }
      }
      throw err;
    }
  },
});
