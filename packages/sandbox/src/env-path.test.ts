import { describe, expect, it } from 'vitest';
import { scrubEnvironment } from './index.js';

describe('a run’s own directories on PATH', () => {
  it('come first, before the minimal PATH, in the order given', () => {
    const env = scrubEnvironment({
      parent: { PATH: '/home/someone/bin:/usr/bin' },
      jailHome: '/tmp/jail',
      minimalPath: true,
      interpreter: '/opt/node/bin/node',
      pathPrefix: ['/run/layout/node_modules/.bin', '/run/other/.bin'],
    });
    expect(env.PATH).toBe(
      '/run/layout/node_modules/.bin:/run/other/.bin:/opt/node/bin:/usr/bin:/bin',
    );
  });

  it('leave PATH as it was when none are given', () => {
    expect(
      scrubEnvironment({ parent: {}, jailHome: '/tmp/jail', minimalPath: true })
        .PATH,
    ).toBe('/usr/bin:/bin');
  });
});
