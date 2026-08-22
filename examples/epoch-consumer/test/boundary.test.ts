import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const forbidden =
  /(?:from\s*|import\s+|import\s*\(\s*|require\s*\(\s*)["'](?:epoch|@epoch\/[^"']+|atproto|@atproto\/[^"']+)["']/u;
const forbiddenRust =
  /(?:\buse|\bextern\s+crate)\s+(?:epoch|atproto)(?:::|\s|;)/u;

describe('Epoch production dependency boundary', () => {
  it('rejects Epoch and ATProto imports from production OpenPacker code', async () => {
    const violations: string[] = [];
    for (const directory of ['packages', 'apps', 'crates', 'integrations']) {
      for (const file of await files(resolve(root, directory))) {
        if (
          !/\.(?:[cm]?[jt]s|json|rs|lua|toml)$/u.test(file) ||
          file.includes('/dist/')
        )
          continue;
        const text = await readFile(file, 'utf8');
        if (forbidden.test(text) || forbiddenRust.test(text))
          violations.push(file.slice(root.length + 1));
        if (file.endsWith('package.json')) {
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          const manifest = JSON.parse(text) as Record<
            string,
            Record<string, string> | undefined
          >;
          for (const field of [
            'dependencies',
            'devDependencies',
            'peerDependencies',
            'optionalDependencies',
          ]) {
            for (const name of Object.keys(manifest[field] ?? {})) {
              if (
                name === 'epoch' ||
                name === 'atproto' ||
                name.startsWith('@epoch/') ||
                name.startsWith('@atproto/')
              )
                violations.push(
                  `${file.slice(root.length + 1)}#${field}.${name}`,
                );
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}
