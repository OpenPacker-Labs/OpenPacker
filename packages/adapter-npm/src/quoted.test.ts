import { describe, expect, it } from 'vitest';
import { quoted, unsafeNameProblem } from './layout-plan.js';
import { chainOfLockPath } from './lock-tree.js';

/**
 * A name in a message shows every character that is not shown otherwise, so a
 * name that differs from another by an invisible character does not read as
 * the same name and the message does not read as untrue.
 */

const INVISIBLE = 'member​‮\u0085';

describe('a name quoted in a message', () => {
  it('is written out where a terminal would show nothing', () => {
    expect(quoted(INVISIBLE)).toBe('"member\\u{200b}\\u{202e}\\u{85}"');
    expect(quoted('a b\u007fc­x')).toBe('"a\\u{2028}b\\u{7f}c\\u{ad}x"');
  });

  it('is plain JSON for any other name', () => {
    expect(quoted('member')).toBe('"member"');
    expect(quoted('@scope/naïve ключ 键 \u{1f511}')).toBe(
      JSON.stringify('@scope/naïve ключ 键 \u{1f511}'),
    );
    expect(quoted('a"b\\c\n')).toBe(JSON.stringify('a"b\\c\n'));
  });

  it('says why a name with an invisible character is not a safe one, in characters that show', () => {
    expect(unsafeNameProblem(INVISIBLE)).toBe(
      '"member\\u{200b}\\u{202e}\\u{85}" is not a safe directory name for node_modules',
    );
    expect(unsafeNameProblem('.bin')).toBe(
      '".bin" is not a safe directory name for node_modules',
    );
  });

  it('says it of a lock path too', () => {
    let message = '';
    try {
      chainOfLockPath(`node_modules/${INVISIBLE}`);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe(
      'The lock path "node_modules/member\\u{200b}\\u{202e}\\u{85}": ' +
        '"member\\u{200b}\\u{202e}\\u{85}" is not a safe directory name for node_modules',
    );
  });
});
