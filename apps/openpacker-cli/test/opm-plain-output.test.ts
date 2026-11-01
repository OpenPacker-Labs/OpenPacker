import { describe, expect, it } from 'vitest';
import {
  HOSTILE,
  ciProject,
  lines,
  runWith,
  violations,
} from './plain-fixture.js';
import {
  member,
  npmFiles,
  opmFiles,
  renameKey,
  type Json,
  type Ran,
  type TomlSections,
} from './repo-fixture.js';

/**
 * A cloned repository's file cannot shape what opm writes, on either stream,
 * whichever command reads it: no line that looks like opm's own after any kind
 * of line break, and none of the characters a terminal acts on (escape and C1
 * sequences, bidirectional overrides, a lone carriage return). The same
 * repository is run with `x` and with hostile text in a field, and the two
 * outputs have the same number of lines.
 */
async function expectPlain(
  go: (text: string) => Promise<Ran>,
  // `opm manifest` prints a JSON document on stdout: what a string in it holds is
  // the document's content, so only its stderr is held to this.
  streams: { stdout: boolean } = { stdout: true },
): Promise<void> {
  const innocent = await go('x');
  const hostile = await go(HOSTILE);
  if (streams.stdout) {
    expect(violations(hostile.out)).toEqual([]);
    expect(lines(hostile.out)).toBe(lines(innocent.out));
  }
  expect(violations(hostile.err)).toEqual([]);
  expect(lines(hostile.err)).toBe(lines(innocent.err));
}

describe('opm ci, after it has installed', () => {
  const CI = [
    ['ci'],
    ['ci', '--production'],
    ['ci', '--omit', 'optional'],
  ] as const;

  it.each(CI)(
    'names a package that declares an install script on one line (%#)',
    async (...argv) => {
      const go = ciProject((builds, text) => {
        builds.version = `3.0.0${text}`;
      });
      const innocent = await go('x', [...argv]);
      expect(innocent.out).toContain('install script not run: builds@3.0.0x');
      await expectPlain((text) => go(text, [...argv]));
    },
  );

  it('names it on one line whatever its name field holds', async () => {
    const go = ciProject((builds, text) => {
      builds.name = `builds${text}`;
    });
    await expectPlain((text) => go(text, ['ci']));
  });
});

describe('opm run', () => {
  const project = (edit: (scripts: Json, text: string) => void) => {
    return (text: string, argv: string[]) => {
      const scripts: Json = { build: 'echo build' };
      edit(scripts, text);
      return runWith(
        {
          'package.json': JSON.stringify({
            name: 'p',
            version: '1.0.0',
            scripts,
          }),
        },
        argv,
      );
    };
  };

  it('lists a script with a hostile name on one line', async () => {
    const go = project((scripts, text) => {
      scripts[`x${text}`] = 'echo hi';
    });
    const innocent = await go('x', ['run']);
    expect(innocent.out).toContain('xx\techo hi');
    await expectPlain((text) => go(text, ['run']));
  });

  it('lists a script with a hostile command on one line', async () => {
    const go = project((scripts, text) => {
      scripts.x = `echo hi${text}`;
    });
    await expectPlain((text) => go(text, ['run']));
  });

  it('keeps showing a command with a line feed as \\n', async () => {
    const ran = await project((scripts) => {
      scripts.two = 'echo a\necho b';
    })('x', ['run']);
    expect(ran.out).toContain('two\techo a\\necho b\n');
  });

  it('shows a tab in a name or a command as a space', async () => {
    // The one change to text with nothing hostile in it: a tab would pass for the
    // column between the name and the command.
    const ran = await project((scripts) => {
      scripts['a\tb'] = 'echo\thi';
    })('x', ['run']);
    expect(ran.out).toContain('a b\techo hi\n');
  });

  it('names the scripts it has, on one line, when one is not there', async () => {
    const go = project((scripts, text) => {
      scripts[`x${text}`] = 'echo hi';
    });
    await expectPlain((text) => go(text, ['run', 'missing']));
  });

  it('refuses a package.json that is not JSON in one line', async () => {
    await expectPlain((text) =>
      runWith({ 'package.json': `{"scripts":${text}` }, ['run']),
    );
  });
});

describe('opm exec, for a bin the lock declares and node_modules lacks', () => {
  const project =
    (edit: (lock: Json, toml: TomlSections, text: string) => void) =>
    (text: string) =>
      runWith(
        {
          ...npmFiles('plain', () => {}),
          ...opmFiles((lock, toml) => edit(lock, toml, text)),
        },
        ['exec', 'ax'],
      );

  it.each<[string, (lock: Json, toml: TomlSections, text: string) => void]>([
    [
      'an alias',
      (lock, _toml, text) =>
        renameKey(member(lock, 'packages'), 'a', `a${text}`),
    ],
    [
      'a purl',
      (lock, _toml, text) => {
        member(lock, 'packages', 'a').purl = `pkg:npm/a${text}`;
      },
    ],
  ])(
    'names the package that would provide it on one line: %s',
    async (_, edit) => {
      const ran = await project(edit)('x');
      expect(ran.err).toContain('The lock would provide it through:');
      await expectPlain(async (text) => project(edit)(text));
    },
  );
});

describe('opm manifest, for a project whose lock names an ecosystem', () => {
  it('says what it leaves out of the manifest on one line', async () => {
    const go = (text: string) =>
      runWith(
        {
          ...npmFiles('plain', () => {}),
          ...opmFiles((lock) => {
            const packages = member(lock, 'packages');
            // A second package in a real ecosystem keeps the manifest buildable.
            packages.b = { ...member(lock, 'packages', 'a') };
            member(lock, 'packages', 'a').ecosystem = `go${text}`;
          }),
        },
        ['manifest'],
      );
    expect((await go('x')).err).toContain(
      'NATIVE_DISTRIBUTION_ABSENT: This project has no gox project file',
    );
    // The JSON document on stdout holds what a string in it holds: only stderr is held to this.
    await expectPlain(go, { stdout: false });
  });
});

describe('opm pack, for a project with an environment file', () => {
  it('names the file it leaves out on one line', async () => {
    const go = (text: string) =>
      runWith(
        {
          'package.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
          'opm.toml': '[project]\nname = "p"\necosystems = ["npm"]\n',
          'index.js': 'x\n',
          // A file name holds anything but a slash.
          [`.env.${text.replaceAll('/', '_')}`]: 'SECRET=1\n',
        },
        ['pack', 'npm', '--package-version', '1.0.0'],
      );
    expect((await go('x')).err).toContain(
      'NORMALIZED_SENSITIVE_FILES_EXCLUDED: .env.x\n',
    );
    await expectPlain(go);
  });
});
