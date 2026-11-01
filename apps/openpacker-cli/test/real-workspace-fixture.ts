/**
 * The member lists of four real repositories (HoBo, ai-bdd, ts-autocode,
 * gitlang), written as workspaces on disk. The manifests are wave one's
 * fixtures in packages/opm-project/test/fixtures/workspaces: names, versions,
 * workspaces and the dependency lists, no source. Every member gets one script
 * that appends its directory to order.log, so a run is read back as an order.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

export interface Fixture {
  repo: string;
  declaration: { file: string; text?: string };
  root: Record<string, unknown>;
  bare: string[];
  members: Record<string, Record<string, unknown>>;
}

const made: string[] = [];
afterAll(async () => {
  await Promise.all(
    made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const MARK = 'echo "${PWD#"$INIT_CWD"/}" >> "$INIT_CWD/order.log"';

/** The named repository's workspace in a fresh temporary directory. */
export async function buildRealWorkspace(
  name: string,
): Promise<{ root: string; fixture: Fixture }> {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        `../../../packages/opm-project/test/fixtures/workspaces/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Fixture;
  const root = await mkdtemp(join(tmpdir(), `opm-real-${name}-`));
  made.push(root);
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await write(
    'package.json',
    JSON.stringify({ ...fixture.root, scripts: { build: MARK } }),
  );
  if (fixture.declaration.text !== undefined)
    await write('pnpm-workspace.yaml', fixture.declaration.text);
  for (const [dir, manifest] of Object.entries(fixture.members))
    await write(
      `${dir}/package.json`,
      JSON.stringify({ ...manifest, scripts: { build: MARK } }),
    );
  for (const dir of fixture.bare)
    await mkdir(join(root, dir), { recursive: true });
  return { root, fixture };
}
