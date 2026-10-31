import { describe, expect, it } from 'vitest';
import { EXIT_CODES, runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';
import { jailed, scriptedProject } from './ci-scripts-fixture.js';

/**
 * `opm ci` lists the approved scripts it ran in the order it ran them, a
 * package after the approved packages it depends on, and names a cycle whose
 * scripts ran in the lock's order (ADR 0060 §7).
 */

const writes = (name: string) =>
  `node -e "require('fs').writeFileSync('built.txt', '${name}')"`;

describe.skipIf(!jailed)('opm ci: the order of approved scripts', () => {
  it('lists each approved script in the order it ran, dependencies first', async () => {
    const p = await scriptedProject(
      [
        {
          name: 'a',
          dependencies: ['b'],
          scripts: {
            postinstall:
              "node -e \"require('fs').readFileSync(require.resolve('b/built.txt'))\"",
          },
        },
        { name: 'b', scripts: { postinstall: writes('b') } },
      ],
      ['a'],
      { trustedDependencies: ['a', 'b'] },
    );
    const c = capture();
    const code = await runOpm(['ci', '--path', p.dir], c.io, '/', {
      fetch: p.fetcher,
    });
    expect(c.err).toBe('');
    expect(code).toBe(EXIT_CODES.success);
    const ran = c.out
      .split('\n')
      .filter((line) => line.includes('install script run'));
    expect(ran).toEqual([
      '  install script run, as the project approved: b@1.0.0 (node_modules/b)',
      '  install script run, as the project approved: a@1.0.0 (node_modules/a)',
    ]);
    expect(c.out).not.toContain('cycle');
  });

  it("names a cycle of approved packages, which ran in the lock's order", async () => {
    const p = await scriptedProject(
      [
        {
          name: 'a',
          dependencies: ['b'],
          scripts: { postinstall: writes('a') },
        },
        {
          name: 'b',
          dependencies: ['a'],
          scripts: { postinstall: writes('b') },
        },
      ],
      ['a', 'b'],
      { pnpm: { onlyBuiltDependencies: ['a', 'b'] } },
    );
    const c = capture();
    const code = await runOpm(['ci', '--path', p.dir], c.io, '/', {
      fetch: p.fetcher,
    });
    expect(c.err).toBe('');
    expect(code).toBe(EXIT_CODES.success);
    expect(c.out).toContain(
      "  install scripts in a dependency cycle, run in the lock's order: a@1.0.0 (node_modules/a), b@1.0.0 (node_modules/b)\n",
    );
  });
});
