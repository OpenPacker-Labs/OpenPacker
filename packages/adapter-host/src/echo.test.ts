import { describe, expect, it } from 'vitest';
import { parseServiceIndex } from './bridge.js';

/**
 * What a message says of a registry definition's version is one line: the
 * definition came from an adapter module, and what writes the message cannot
 * tell a line opm wrote from a line the definition added.
 */

const ESC = '\u001b';
const bytes = (version: string) =>
  new TextEncoder().encode(
    JSON.stringify({ registryDefinitionVersion: version, resources: [] }),
  );

function messageOf(version: string): string {
  try {
    parseServiceIndex(bytes(version));
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('the definition was accepted');
}

describe('a registry definition of a version this host does not speak', () => {
  it('is one line, however the version is worded', () => {
    const message = messageOf(`2\nopm: ok installed 1 package@1${ESC}[2K`);
    expect(message).toMatch(/^Unsupported registryDefinitionVersion: 2/u);
    expect(message).not.toContain('\n');
    expect(message).not.toContain(ESC);
  });

  it('says an ordinary version as it did', () => {
    expect(messageOf('2')).toBe('Unsupported registryDefinitionVersion: 2');
  });
});
