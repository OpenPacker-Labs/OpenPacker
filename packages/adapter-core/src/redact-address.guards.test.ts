import { describe, expect, it } from 'vitest';
import { redactAddress } from './redact-address.js';
import { LONGEST_HOST_LENGTH } from '@openpacker/canonical';

/**
 * Milliseconds of CPU this process has spent, user and system: what the work
 * under test costs. A busy machine stretches the wall clock by every time slice
 * it takes away; it does not add to this.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/**
 * Two checks of `redactAddress` that a change to the file could drop without
 * any other test of this package noticing (found by changing the file by hand,
 * one line at a time): the `@` in the query or fragment of a `blob:` URL, and
 * the host no DNS name could be.
 */

/** Stands for a credential. */
const MARKER = 'vtok_dummy_marker_0123456789abcdef';

describe('a blob URL whose password is split by a ? or a #', () => {
  // `blob:https://deploy:1234?<c>@host/x` is a blob URL whose path is
  // `https://deploy:1234` and whose query holds the rest of the password. Shown
  // as its path it is a host `deploy`, a port `1234`: the user name and the
  // first digits of the password.
  it.each([
    ['?', `blob:https://deploy:1234?${MARKER}@host.example/x.tgz`],
    ['#', `blob:https://deploy:1234#${MARKER}@host.example/x.tgz`],
    ['? and a path', `blob:https://deploy:1234/y?${MARKER}@host.example/x`],
  ])('is withheld, with a %s', (_, address) => {
    const shown = redactAddress(address);
    expect(shown).toBe('blob:[address withheld]');
    expect(shown).not.toContain('deploy');
    expect(shown).not.toContain('1234');
  });

  it('is shown when it holds no @ after its address', () => {
    expect(redactAddress('blob:https://h.example/x?q=1#f')).toBe(
      'blob:https://h.example/x',
    );
  });
});

describe('a host no DNS name could be is not handed to the URL parser', () => {
  const started = () => cpuMs();

  it('is [url] from 254 characters as written, and shown at 253', () => {
    const label = (length: number) =>
      `${'a'.repeat(length - 4)}.com`.slice(0, length);
    expect(label(LONGEST_HOST_LENGTH)).toHaveLength(LONGEST_HOST_LENGTH);
    expect(redactAddress(`https://${label(LONGEST_HOST_LENGTH)}/x`)).toBe(
      `https://${label(LONGEST_HOST_LENGTH)}/x`,
    );
    expect(redactAddress(`https://${label(LONGEST_HOST_LENGTH + 1)}/x`)).toBe(
      '[url]',
    );
    expect(
      redactAddress(`blob:https://${label(LONGEST_HOST_LENGTH + 1)}/x`),
    ).toBe('[url]');
  });

  it.each([
    ['raw', 'ß.é.'.repeat(24_000)],
    ['percent-escaped', '%C3%A9.'.repeat(24_000)],
  ])('is [url] at once for a host of many labels, %s', (_, host) => {
    // Node's parser takes the square of the length of a host like this one:
    // 0.35 s for 65,543 characters, 6.9 s for 262,151.
    const before = started();
    expect(redactAddress(`http://${host}`)).toBe('[url]');
    expect(redactAddress(`http://${MARKER}@${host}/p`)).toBe('[url]');
    expect(cpuMs() - before).toBeLessThan(500);
  });
});
