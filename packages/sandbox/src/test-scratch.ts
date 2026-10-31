import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/** A directory under the temp directory, removed when the test that made it ends. */
export function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
