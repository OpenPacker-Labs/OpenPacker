/**
 * What opm does with each archive of test/tar-oracle/oracle.json, by case name,
 * in the order of the oracle (tar-end.test.ts checks the order). The readers are
 * node-tar 6.2.1 (npm 10.9.4's) and 7.5.22 (npm 11's) as `Parse` and as `tar.x`
 * with pacote's filter, and pnpm 10.28.0's `parseTarball`.
 */

type Files = Array<[string, string]>;

/** The code opm refuses each oracle case with, by case name. */
export interface ExpectedCodes {
  [name: string]: string;
}

/** The files opm installs from an oracle case, by case name. */
export interface ExpectedFiles {
  [name: string]: Files;
}

/** The code opm refuses each case with where npm and pnpm disagree. */
export const REFUSED: ExpectedCodes = {
  'the end of the data ends it': 'TAR_AMBIGUOUS_END',
  'a lone zero block between entries': 'TAR_AMBIGUOUS_END',
  'lone zero blocks between three entries': 'TAR_AMBIGUOUS_END',
  'a lone zero block before the first entry': 'TAR_AMBIGUOUS_END',
  'a lone zero block, a block that is not a header, then an entry':
    'TAR_AMBIGUOUS_END',
  'a node-tar null block between entries': 'TAR_AMBIGUOUS_END',
  'an 8-digit checksum with no terminator, typeflag 0 after it':
    'TAR_AMBIGUOUS_CHECKSUM',
  'a prefix in a header without ustar magic': 'TAR_AMBIGUOUS_PREFIX',
  'a prefix in a GNU header (magic "ustar  ")': 'TAR_AMBIGUOUS_PREFIX',
  'a prefix under magic "ustar" and a version that is not "00"':
    'TAR_AMBIGUOUS_PREFIX',
  'a header whose name starts with NUL, its path in the prefix':
    'TAR_AMBIGUOUS_END',
  'a directory with a size hides the entries inside it':
    'TAR_AMBIGUOUS_DIRECTORY',
  'a file named like a directory, with a size, hides the entries inside it':
    'TAR_AMBIGUOUS_DIRECTORY',
  'a NUL-typed file named like a directory, with a size, hides the entries inside it':
    'TAR_AMBIGUOUS_DIRECTORY',
  'a directory with a size hides a header and leaves a payload that starts with NUL':
    'TAR_AMBIGUOUS_DIRECTORY',
  'a file named like a directory, with no size': 'TAR_AMBIGUOUS_DIRECTORY',
  'a uid that is an invalid base-256 number': 'TAR_AMBIGUOUS_NUMBER',
  'a gid that is an invalid base-256 number': 'TAR_AMBIGUOUS_NUMBER',
  'an mtime that is an invalid base-256 number': 'TAR_AMBIGUOUS_NUMBER',
  'a devmajor that is an invalid base-256 number': 'TAR_AMBIGUOUS_NUMBER',
  'a devminor that is an invalid base-256 number': 'TAR_AMBIGUOUS_NUMBER',
  'an atime that is an invalid base-256 number': 'TAR_AMBIGUOUS_NUMBER',
  'a ctime that is an invalid base-256 number': 'TAR_AMBIGUOUS_NUMBER',
  'a uid that is a base-256 number too large to be safe':
    'TAR_AMBIGUOUS_NUMBER',
  'a size field that is a NUL, then digits': 'TAR_AMBIGUOUS_NUMBER',
  'a size field that is a NUL, ten zeros and a last digit':
    'TAR_AMBIGUOUS_NUMBER',
  'a size field that is a line feed, a space and digits':
    'TAR_AMBIGUOUS_NUMBER',
  'a size field that is a tab, a space and digits': 'TAR_AMBIGUOUS_NUMBER',
  'a checksum field that is a line feed, a space and digits':
    'TAR_AMBIGUOUS_CHECKSUM',
  'a mode field that is a NUL, then digits': 'TAR_AMBIGUOUS_NUMBER',
  'a mode field that is a line feed, a space and digits':
    'TAR_AMBIGUOUS_NUMBER',
  'a mode field that is a tab, a space and digits': 'TAR_AMBIGUOUS_NUMBER',
  'an extended header with a path, a global header, then a file':
    'TAR_AMBIGUOUS_PAX',
  'a contiguous file (typeflag 7)': 'TAR_AMBIGUOUS_TYPE',
  'a file with a link name': 'TAR_AMBIGUOUS_LINK',
  'an extended header with a link name, then a file': 'TAR_AMBIGUOUS_LINK',
  'a path record with a newline in its value': 'TAR_AMBIGUOUS_PAX',
  'a path record smuggled in a comment record': 'TAR_AMBIGUOUS_PAX',
  'a size record smuggled in a comment record': 'TAR_AMBIGUOUS_PAX',
  'a path record that ends in a newline': 'TAR_AMBIGUOUS_PAX',
  'a benign file, then the same name behind a path with a newline':
    'TAR_AMBIGUOUS_PAX',
  'a newline in the second of two records': 'TAR_AMBIGUOUS_PAX',
  'a pax length with a leading zero': 'INVALID_PAX_HEADER',
  'a pax record with no final newline': 'INVALID_PAX_HEADER',
  'an extended header with a path, a directory with a link name, then a file':
    'TAR_AMBIGUOUS_LINK',
  'a one-character link name on a file hides a forged entry':
    'TAR_AMBIGUOUS_LINK',
  'a pax record whose key starts with a line feed': 'TAR_AMBIGUOUS_PAX',
  'a linkpath record that is a number, then a file': 'TAR_AMBIGUOUS_PAX',
  'a linkpath record that leaves the directory, then a file':
    'TAR_AMBIGUOUS_PAX',
  'a file whose only path component has a backslash': 'TAR_AMBIGUOUS_PATH',
  'a file with no directory above it': 'TAR_AMBIGUOUS_PATH',
  'a name with a NUL and a line feed in it': 'TAR_AMBIGUOUS_TEXT',
  'a name with a NUL and a carriage return in it': 'TAR_AMBIGUOUS_TEXT',
  'a name with a NUL and a U+2028 in it': 'TAR_AMBIGUOUS_TEXT',
  'a prefix with a NUL and a line feed in it': 'TAR_AMBIGUOUS_TEXT',
  'a link name of a NUL and a line feed, on a file': 'TAR_AMBIGUOUS_TEXT',
  'a link name of a NUL and a line feed hides a forged entry':
    'TAR_AMBIGUOUS_TEXT',
  'an extended header with a character across offset 512 of its body':
    'TAR_AMBIGUOUS_PAX',
  'an extended header with a character across offset 16,384':
    'TAR_AMBIGUOUS_PAX',
};

/**
 * Refused although npm and pnpm install the same files: opm cannot say that
 * its own reading of them is theirs, so it refuses rather than guess.
 */
export const OVER_REFUSED: ExpectedCodes = {
  'an extended header with a size, a global header, then a file':
    'TAR_AMBIGUOUS_PAX',
  'a directory with a link name': 'TAR_AMBIGUOUS_LINK',
  'a file with a backslash below the top-level directory': 'TAR_AMBIGUOUS_PATH',
  'a name with data after a NUL and no line terminator': 'TAR_AMBIGUOUS_TEXT',
  'a longer extended header with non-ASCII bytes no cut can split':
    'TAR_AMBIGUOUS_PAX',
  'a lone zero block, then a header with no path': 'TAR_AMBIGUOUS_END',
  'a lone zero block, then a directory': 'TAR_AMBIGUOUS_END',
  'a lone zero block, then a base-256 checksum': 'TAR_AMBIGUOUS_END',
  'a directory whose checksum field node-tar reads as another number':
    'TAR_AMBIGUOUS_CHECKSUM',
  'a directory whose uid is an invalid base-256 number': 'TAR_AMBIGUOUS_NUMBER',
  'a directory with a size whose span holds only zero blocks':
    'TAR_AMBIGUOUS_DIRECTORY',
  'an extended header with a path, a global header, then a directory':
    'TAR_AMBIGUOUS_PAX',
  'a prefix without ustar magic, under an extended header with a path':
    'TAR_AMBIGUOUS_PREFIX',
  'a comment record with a newline in its value': 'TAR_AMBIGUOUS_PAX',
  'a record with a newline in its key': 'TAR_AMBIGUOUS_PAX',
  'a global header with a link name': 'TAR_AMBIGUOUS_LINK',
};

/**
 * Extracted although npm's set and opm's differ: the paths opm returns (the
 * first component stripped, as above) where `npm` is what node-tar installs.
 * A leading `./` is node-tar's first component, which it strips; opm drops the
 * `.` segment as npm's extractor does for any other (`acceptRedundantEntries`),
 * so `package/` is left for the layout to unwrap.
 */
export const PINNED: ExpectedFiles = {
  'a file whose name starts with ./': [
    ['a.js', 'a'],
    ['dot.js', 'd'],
  ],
};

/**
 * What npm writes (node-tar's `tar.x` with pacote 19.0.1's filter) differs from
 * what node-tar's `Parse` reads, which is what the rest of this file compares,
 * only for the ignore files pacote renames: `.gitignore` becomes `.npmignore`,
 * and is dropped if a `.npmignore` came first. The rename is a name map on an
 * inert file, applied to every tarball however it is read; opm and pnpm keep
 * the name, and neither is refused for it.
 */
export const PACOTE: ExpectedFiles = {
  'a .gitignore file': [
    ['.npmignore', 'G'],
    ['a.js', 'a'],
  ],
  'a .npmignore, then a .gitignore': [
    ['.npmignore', 'N'],
    ['a.js', 'a'],
  ],
  'a .gitignore, then a .npmignore': [
    ['.npmignore', 'N'],
    ['a.js', 'a'],
  ],
};
