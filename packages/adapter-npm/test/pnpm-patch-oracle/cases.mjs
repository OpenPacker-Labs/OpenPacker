/**
 * The inputs the oracle runs pnpm's own code over (README.md). Each apply case
 * is a package (file path to text) and a patch; each hash case is the bytes of
 * a patch file, in base64.
 */

import { crlf, MODIFY } from './case-text.mjs';
import { FILE_CASES } from './cases-files.mjs';
import { HUNK_CASES } from './cases-hunks.mjs';

export const APPLY_CASES = [...HUNK_CASES, ...FILE_CASES];

const PATCH = Buffer.from(MODIFY, 'utf8');

export const HASH_CASES = [
  { name: 'LF', base64: PATCH.toString('base64') },
  { name: 'CRLF', base64: Buffer.from(crlf(MODIFY)).toString('base64') },
  {
    name: 'a lone CR stays',
    base64: Buffer.from(MODIFY.replace('+B\n', '+B\r\r\n')).toString('base64'),
  },
  {
    name: 'a byte order mark',
    base64: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PATCH]).toString(
      'base64',
    ),
  },
  {
    name: 'bytes that are not UTF-8',
    base64: Buffer.concat([
      PATCH,
      Buffer.from([0xff, 0xfe, 0x80, 0x0a]),
    ]).toString('base64'),
  },
  { name: 'empty', base64: '' },
  {
    name: 'text that is not ASCII',
    base64: Buffer.from('héllo ✓ 😀\r\n').toString('base64'),
  },
];
