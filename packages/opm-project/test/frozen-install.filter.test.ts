import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, standard } from './frozen-workspace-fixture.js';

afterEach(cleanup);

/**
 * `--filter` chooses members by pnpm's grammar for any workspace lock, and
 * what is installed is what `--workspace` installs (ADR 0055 §16).
 */
describe('installFrozen --filter on an npm workspace lock', () => {
  it('installs the filtered member and what it needs, as -w does', async () => {
    const byFilter = await standard();
    await byFilter.write();
    const filtered = await byFilter.install({ workspace: { filter: ['two'] } });
    const byName = await standard();
    await byName.write();
    const named = await byName.install({ workspace: { select: ['two'] } });
    expect(filtered.workspace).toEqual(named.workspace);
    expect(filtered.installed).toBe(named.installed);
    expect(await byFilter.list('node_modules')).toEqual(
      await byName.list('node_modules'),
    );
  });

  it("reads pnpm selectors npm's -w cannot: a glob, a dependency closure, an exclusion", async () => {
    const w = await standard();
    await w.write();
    const result = await w.install({
      workspace: { filter: ['./packages/*', '!one'] },
    });
    expect(result.workspace).toEqual({ members: 2, linked: 1 });
    expect(
      (await w.list('node_modules')).filter((n) => !n.startsWith('.')),
    ).toEqual(['b', 'dd', 'two']);
  });

  it('refuses a selector that matches nothing, and one mixed with -w', async () => {
    const w = await standard();
    await w.write();
    await expect(
      w.install({ workspace: { filter: ['nobody'] } }),
    ).rejects.toThrow(/nobody/u);
    await expect(
      w.install({ workspace: { filter: ['one'], select: ['one'] } }),
    ).rejects.toThrow(/pnpm's grammar and --workspace by npm's/u);
  });
});
