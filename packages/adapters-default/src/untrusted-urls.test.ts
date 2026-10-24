import { describe, expect, it } from 'vitest';
import { defaultAdapterModules } from './index.js';
import { standardEmitters } from './standard-pack.js';
import { normalized } from './standard-pack.fixture.js';

/**
 * A WinGet manifest in a repository, and a registry endpoint in a project's
 * settings, are text someone else wrote. Each is read through the guard, so a
 * host no DNS name could be is refused in a few milliseconds and not the most of
 * a second the URL parser takes on 65,550 characters of it
 * (`@openpacker/canonical`'s `untrusted-url.test.ts` measures that), and the
 * refusal repeats none of it.
 */
const HOST = 'ß.é.'.repeat(16384);
const FAST_MS = 50;

async function refusal(
  run: () => void,
): Promise<{ error: Error | undefined; ms: number }> {
  let error: Error | undefined;
  let ms = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    try {
      await run();
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
    ms = Math.min(ms, performance.now() - started);
  }
  return { error, ms };
}

describe('a WinGet manifest with an InstallerUrl no DNS name could be', () => {
  it('is refused as an invalid installer URL in under 50 ms', async () => {
    const input = normalized('winget');
    const text = new TextDecoder().decode(input.files[0]!.contents);
    input.files[0]!.contents = new TextEncoder().encode(
      text.replace(
        'https://example.invalid/demo.exe',
        `https://${HOST}/demo.exe`,
      ),
    );
    const { error, ms } = await refusal(() =>
      standardEmitters.winget.emit(input),
    );
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(error?.message).toMatch(/contains an invalid InstallerUrl/u);
    expect(error?.message).not.toContain('ß');
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('still takes an ordinary one', async () => {
    const artifacts = await standardEmitters.winget.emit(normalized('winget'));
    expect(artifacts).toHaveLength(1);
  });
});

describe('a registry endpoint no DNS name could be a host of', () => {
  it.each(['npm', 'cargo', 'pypi', 'nuget', 'maven', 'golang', 'oci'])(
    'is not read for %s',
    async (ecosystem) => {
      const module = defaultAdapterModules().find(
        (candidate) => candidate.id === `org.openpacker.adapter.${ecosystem}`,
      );
      const { error, ms } = await refusal(() =>
        module?.catalog?.({ endpoint: `https://${HOST}` }),
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(error?.message).not.toContain('ß');
      expect(error?.message.length).toBeLessThan(200);
      expect(ms).toBeLessThan(FAST_MS);
    },
  );
});
