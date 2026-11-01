import { describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import {
  INSTALLED_TIMEOUT_MS,
  binPackage,
  installedProject,
} from './installed-fixture.js';

const yes = binPackage('yes', `process.stdout.write('y\\n');`);

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get stdout() {
      return out;
    },
    get stderr() {
      return err;
    },
  };
}

describe('opm shell --isolate', () => {
  it(
    'still prints exports without --isolate',
    async () => {
      const root = await installedProject([yes]);
      const cap = capture();
      expect(await runOpm(['shell'], cap.io, root)).toBe(0);
      expect(cap.stdout).toMatch(/export OPM_BIN=/u);
    },
    INSTALLED_TIMEOUT_MS,
  );

  it(
    'fails closed when isolate is requested without backends',
    async () => {
      const root = await installedProject([yes]);
      const cap = capture();
      const code = await runOpm(
        ['shell', '--isolate', '--', 'echo', 'hi'],
        cap.io,
        root,
      );
      expect(code).toBe(8);
      expect(cap.stderr).toMatch(/No isolated dev shell backend/u);
    },
    INSTALLED_TIMEOUT_MS,
  );
});
