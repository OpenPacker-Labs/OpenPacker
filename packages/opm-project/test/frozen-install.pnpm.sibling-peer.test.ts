/**
 * A peer a workspace sibling satisfies (`plug@1.0.0(ui@link:../ui)`, whose
 * snapshot depends on `ui` as `link:../ui`) is refused, and the refusal says
 * which peer and which sibling, not that a version is not a version (the
 * review of #179, round 6, N-b).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, pnpmWorld } from './frozen-pnpm-fixture.js';

afterEach(cleanup);

describe('a peer satisfied by a workspace sibling', () => {
  it('is refused, naming the package that needs it, the peer and the sibling', async () => {
    const w = await pnpmWorld();
    w.pkg({
      name: 'plug',
      version: '1.0.0',
      suffix: '(ui@link:../ui)',
      deps: { ui: 'link:../ui' },
      extraPackageLines: ['    peerDependencies:', "      ui: '*'"],
    });
    w.importer('.', {});
    w.importer('packages/ui', {}, { name: 'ui' });
    w.importer('packages/web', {
      dependencies: {
        plug: ['^1.0.0', '1.0.0(ui@link:../ui)'],
        ui: ['workspace:*', 'link:../ui'],
      },
    });
    await w.write();
    const error = await w.install().then(
      () => undefined,
      (thrown: Error) => thrown,
    );
    expect(error).toMatchObject({ code: 'INVALID_LOCK' });
    expect(error?.message).toContain(
      'importers["packages/web"].dependencies["plug"]',
    );
    expect(error?.message).toContain(
      'the peer "ui" satisfied by the workspace member at "../ui"',
    );
  });
});
