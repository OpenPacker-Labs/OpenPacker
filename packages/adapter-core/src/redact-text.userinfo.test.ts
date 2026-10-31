import { describe, expect, it } from 'vitest';
import { redactText } from './redact-text.js';

/**
 * A user name and a password before a host, `user:secret@host`, are a
 * credential with or without a scheme in front of them. A lock's key such as
 * `node_modules/https:/user:TOKEN@r.test` holds one where no `scheme://` and no
 * start of the value marks it, and was repeated whole.
 */

const SECRET = 'vtok_dummy_marker_0123456789abcdef';

describe('a user name and a password before a host, with no scheme', () => {
  it.each([
    `node_modules/https:/user:${SECRET}@r.test`,
    `node_modules/a/node_modules/ci:${SECRET}@registry.test/x`,
    `see ci:${SECRET}@registry.test now`,
    `the key node_modules/https:/user:${SECRET}@r.test and the address https://user:${SECRET}@r.test/x`,
    `https:/user:${SECRET}@r.test then user:${SECRET}@r.test`,
  ])('is withheld: %s', (text) => {
    const shown = redactText(text);
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toMatch(/(?:user|ci):/u);
  });

  it.each([
    'pkg@1.0.0',
    '@scope/name@1.0.0',
    'node_modules/@scope/name',
    'a user@host, with no password',
    'at 12:30 @ noon',
    'node_modules/a:b',
  ])('leaves text with no credential as it is: %s', (text) => {
    expect(redactText(text)).toBe(text);
  });
});
