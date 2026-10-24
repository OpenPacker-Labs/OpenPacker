// Loaded with `node --import` by tests that run this package's TypeScript
// sources in a child process: a relative `./x.js` imported from a `.ts` file
// is the `./x.ts` beside it, as it is for tsc.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      context.parentURL?.endsWith('.ts') === true
    ) {
      const source = new URL(
        specifier.replace(/\.js$/u, '.ts'),
        context.parentURL,
      );
      if (existsSync(fileURLToPath(source))) return next(source.href, context);
    }
    return next(specifier, context);
  },
});
