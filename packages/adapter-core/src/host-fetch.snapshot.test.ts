import { describe, expect, it } from 'vitest';
import {
  firstPartyOriginPolicy,
  normalizePinnedOrigin,
  redactUrl,
} from './index.js';

/**
 * Characterization snapshots for host-fetch pin policy. They pin the exact
 * public contract of origin-form pins, URL redaction, and D6-N allowlists so
 * a later change is a reviewable snapshot diff (update with `vitest run -u`).
 */
describe('host-fetch characterization snapshots', () => {
  it('pins URL redaction (origin + path only)', async () => {
    await expect(
      [
        redactUrl(new URL('https://user:secret@pinned.test/path?q=1#h')),
        redactUrl(new URL('https://pinned.test/artifacts/demo.tar')),
        redactUrl(new URL('https://pinned.test/')),
      ].join('\n'),
    ).toMatchFileSnapshot('__snapshots__/redact-url.snap');
  });

  it('pins first-party origin policy for default, override, and extras', async () => {
    const pypi = 'https://pypi.org/pypi';
    const pythonhosted = ['https://files.pythonhosted.org', 'https://pypi.org'];
    const summary = {
      default: firstPartyOriginPolicy({
        endpoint: pypi,
        namedOrOverride: false,
        artifactOrigins: pythonhosted,
      }),
      override: firstPartyOriginPolicy({
        endpoint: 'https://pypi.internal.example',
        namedOrOverride: true,
        artifactOrigins: pythonhosted,
      }),
      overrideWithCdn: firstPartyOriginPolicy({
        endpoint: 'https://pypi.internal.example',
        namedOrOverride: true,
        artifactOrigins: pythonhosted,
        extraOrigins: ['https://files.pythonhosted.org'],
      }),
    };
    await expect(`${JSON.stringify(summary, null, 2)}\n`).toMatchFileSnapshot(
      '__snapshots__/first-party-origin-policy.snap',
    );
  });

  it('pins HTTPS origin-form pin errors without echoing userinfo', async () => {
    const cases: { label: string; value: string }[] = [
      { label: 'http-loopback', value: 'http://127.0.0.1' },
      { label: 'credentialed', value: 'https://user:secret@pinned.test' },
      { label: 'path', value: 'https://pinned.test/foo' },
      { label: 'query', value: 'https://pinned.test/?q=1' },
      { label: 'not-a-url', value: 'not-a-url' },
    ];
    const lines = cases.map(({ label, value }) => {
      try {
        return `${label} -> ${normalizePinnedOrigin(value)}`;
      } catch (error) {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const message = (error as Error).message;
        if (/user:secret/u.test(message)) throw error;
        return `${label} -> ${message}`;
      }
    });
    await expect(lines.join('\n')).toMatchFileSnapshot(
      '__snapshots__/pinned-origin-errors.snap',
    );
  });
});
