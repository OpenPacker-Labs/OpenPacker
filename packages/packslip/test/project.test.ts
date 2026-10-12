import { describe, expect, it } from 'vitest';
import {
  PackslipError,
  bundleFileName,
  forgeIssuer,
  githubListPath,
  githubListUrl,
  listUrl,
  parseProject,
  parseProjectInput,
  repositoryUrl,
} from '../src/index.js';

describe('project names', () => {
  it('reads a GitHub project, with and without a monorepo subpath', () => {
    expect(parseProject('github.com/jdx/mise')).toMatchObject({
      forge: 'github',
      repository: 'jdx/mise',
    });
    expect(parseProject('github.com/jdx/mise').subpath).toBeUndefined();
    expect(parseProject('github.com/biomejs/biome/crates/cli')).toMatchObject({
      forge: 'github',
      repository: 'biomejs/biome',
      subpath: 'crates/cli',
    });
  });

  it('treats a whole GitLab path as the repository, since subgroups nest', () => {
    expect(parseProject('gitlab.com/group/sub/tool')).toMatchObject({
      forge: 'gitlab',
      repository: 'group/sub/tool',
    });
    expect(parseProject('gitlab.com/group/sub/tool').subpath).toBeUndefined();
  });

  it('reads a vendor-domain project with or without a path', () => {
    expect(parseProject('mise.jdx.dev')).toMatchObject({
      forge: 'other',
      segments: [],
    });
    expect(parseProject('example.com/tools/demo')).toMatchObject({
      forge: 'other',
      segments: ['tools', 'demo'],
    });
  });

  it.each([
    ['', 'empty'],
    ['https://github.com/jdx/mise', 'scheme'],
    ['github.com/jdx/mise/', 'trailing slash'],
    ['GitHub.com/jdx/mise', 'uppercase host'],
    ['localhost/tool', 'no dot in host'],
    ['github.com//mise', 'empty segment'],
    ['github.com/jdx/./mise', 'dot segment'],
    ['github.com/jdx/../mise', 'dot-dot segment'],
    ['github.com/jdx/mi se', 'whitespace'],
    ['github.com/jdx/mi\\se', 'backslash'],
    ['github.com/jdx/mi%2e%2e', 'percent escape'],
    ['github.com/jdx/mise?x=1', 'query'],
    ['github.com/jdx/mise#frag', 'fragment'],
    ['user@github.com/jdx/mise', 'userinfo'],
    ['example.com:8443/tool', 'port'],
    ['github.com/jdx', 'a GitHub project needs an owner and a repository'],
    ['gitlab.com/group', 'a GitLab project needs a group and a project'],
    ['-bad.example.com/x', 'host label starts with a hyphen'],
    ['exämple.com/x', 'non-ASCII host'],
    ['example.com/tôol', 'non-ASCII path'],
  ])('refuses %j (%s)', (name) => {
    expect(() => parseProject(name)).toThrow(PackslipError);
  });

  it('accepts what a person types and turns owner/repo into a GitHub project', () => {
    expect(parseProjectInput('jdx/hk').name).toBe('github.com/jdx/hk');
    expect(parseProjectInput('github.com/jdx/hk').name).toBe(
      'github.com/jdx/hk',
    );
    expect(parseProjectInput('mise.jdx.dev').name).toBe('mise.jdx.dev');
    // A pasted URL is a mistake worth surfacing, not something to strip.
    expect(() => parseProjectInput('https://github.com/jdx/hk')).toThrow(
      PackslipError,
    );
  });

  it('names the forge issuer and repository URL', () => {
    expect(forgeIssuer('github')).toBe(
      'https://token.actions.githubusercontent.com',
    );
    expect(forgeIssuer('gitlab')).toBe('https://gitlab.com');
    expect(forgeIssuer('other')).toBeUndefined();
    expect(repositoryUrl(parseProject('github.com/jdx/hk'))).toBe(
      'https://github.com/jdx/hk',
    );
    expect(repositoryUrl(parseProject('mise.jdx.dev'))).toBeUndefined();
  });

  it('names the bundle a monorepo tool ships beside its siblings', () => {
    expect(bundleFileName(parseProject('github.com/jdx/mise'))).toBe(
      'packslip.sigstore.json',
    );
    expect(
      bundleFileName(parseProject('github.com/oxc-project/oxc/oxlint')),
    ).toBe('packslip.oxlint.sigstore.json');
    expect(
      bundleFileName(parseProject('github.com/biomejs/biome/crates/cli')),
    ).toBe('packslip.crates-cli.sigstore.json');
  });

  it('places a release list at the well-known paths the specification gives', () => {
    expect(listUrl(parseProject('mise.jdx.dev'))).toBe(
      'https://mise.jdx.dev/.well-known/packslip.json',
    );
    expect(listUrl(parseProject('jdx.dev/mise'))).toBe(
      'https://jdx.dev/.well-known/packslip/mise.json',
    );
    expect(listUrl(parseProject('github.com/jdx/mise'))).toBe(
      'https://github.com/.well-known/packslip/jdx/mise.json',
    );
    expect(
      listUrl(parseProject('github.com/jdx/mise'), 'registry.example'),
    ).toBe(
      'https://registry.example/.well-known/packslip/github.com/jdx/mise.json',
    );
  });

  it('serves a GitHub project’s supplementary list from its default branch', () => {
    expect(githubListPath(parseProject('github.com/jdx/mise'))).toBe(
      '.well-known/packslip.json',
    );
    expect(
      githubListPath(parseProject('github.com/biomejs/biome/crates/cli')),
    ).toBe('.well-known/packslip/crates/cli.json');
    expect(githubListUrl(parseProject('github.com/jdx/mise'))).toBe(
      'https://raw.githubusercontent.com/jdx/mise/HEAD/.well-known/packslip.json',
    );
    expect(githubListUrl(parseProject('mise.jdx.dev'))).toBeUndefined();
  });
});
