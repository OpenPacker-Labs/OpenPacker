import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES, runCli, type CliIo } from '../src/index.js';

function io(): CliIo & { out: string; err: string } {
  const result = {
    out: '',
    err: '',
    stdin: Readable.from([]),
    stdout: {
      write(value: string | Uint8Array) {
        result.out += value.toString();
        return true;
      },
    },
    stderr: {
      write(value: string | Uint8Array) {
        result.err += value.toString();
        return true;
      },
    },
  };
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe('openpacker CLI', () => {
  it('sends structured commands, enforces offline headers, and preserves JSON output', async () => {
    const response = {
      meta: {
        protocolVersion: '1.0-draft',
        provider: { id: 'fixture', implementation: 'test', version: '1' },
      },
      results: [],
    };
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('x-openpacker-offline')).toBe(
          'true',
        );
        const body = JSON.parse(
          new TextDecoder().decode(init?.body as ArrayBuffer),
        );
        expect(body.items[0]).toEqual({ type: 'purl', value: 'pkg:npm/demo' });
        return Response.json(response);
      },
    );
    vi.stubGlobal('fetch', fetch);
    const output = io();
    expect(
      await runCli(
        ['normalize', 'pkg:npm/demo', '--offline', '--json'],
        output,
      ),
    ).toBe(EXIT_CODES.success);
    expect(JSON.parse(output.out)).toEqual(response);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('treats the whole loopback range as local for --offline', async () => {
    // 127.0.0.0/8 never leaves the machine, so --offline has no reason to
    // refuse it; anything outside the range still does.
    for (const base of [
      'http://127.0.0.1:7337',
      'http://127.0.0.2:7337',
      'http://127.1.2.3:7337',
      'http://[::1]:7337',
      'http://[::ffff:127.0.0.1]:7337',
      'http://localhost:7337',
    ]) {
      vi.stubGlobal('fetch', async () =>
        Response.json({
          meta: {
            protocolVersion: '1.0-draft',
            provider: { id: 'f', implementation: 't', version: '1' },
          },
          results: [],
        }),
      );
      const local = io();
      expect(
        await runCli(
          ['normalize', 'pkg:npm/demo', '--offline', '--base-url', base],
          local,
        ),
        `${base}: ${local.err}`,
      ).toBe(EXIT_CODES.success);
    }
    for (const base of [
      'http://128.0.0.1:7337',
      'http://10.0.0.1:7337',
      'http://127.0.0.1.example.com:7337',
      'https://packages.example',
    ]) {
      const remote = io();
      expect(
        await runCli(
          ['normalize', 'pkg:npm/demo', '--offline', '--base-url', base],
          remote,
        ),
      ).toBe(EXIT_CODES.usage);
      expect(remote.err).toContain('loopback');
    }
  });

  it('uses stable usage and protocol exit codes', async () => {
    const remote = io();
    expect(
      await runCli(
        [
          'solve',
          '--offline',
          '--base-url',
          'https://packages.example',
          '--input',
          '-',
        ],
        remote,
      ),
    ).toBe(EXIT_CODES.usage);
    expect(remote.err).toContain('loopback');

    vi.stubGlobal('fetch', async () =>
      Response.json(
        {
          type: 'urn:problem',
          title: 'Unsatisfiable',
          status: 409,
          code: 'UNSATISFIABLE',
          retryable: false,
        },
        { status: 409 },
      ),
    );
    const unsat = io();
    unsat.stdin = Readable.from(['{}']);
    expect(await runCli(['solve', '--input', '-', '--json'], unsat)).toBe(
      EXIT_CODES.unsatisfiable,
    );
    expect(JSON.parse(unsat.err).error.exitCode).toBe(EXIT_CODES.unsatisfiable);
  });

  it('lists the complete command groups', async () => {
    const output = io();
    expect(await runCli(['--help'], output)).toBe(EXIT_CODES.success);
    for (const name of [
      'normalize',
      'identify',
      'enumerate',
      'inspect',
      'solve',
      'explain',
      'materialize',
      'verify',
      'pack',
      'publish',
      'receipt',
      'catalog',
      'lifecycle',
      'export',
      'serve',
      'demo',
    ])
      expect(output.out).toContain(name);
  });

  it('routes every network command and subcommand to its documented endpoint', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const signedReceipt = {
      receipt: { evaluationTime: '2026-08-03T00:00:00Z' },
      receiptDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
      signatures: [],
    };
    const cases: Array<{
      argv: string[];
      path: string;
      input?: unknown;
    }> = [
      { argv: ['normalize', 'pkg:npm/demo'], path: '/v1/normalize' },
      { argv: ['identify', 'pkg:npm/demo'], path: '/v1/identify' },
      { argv: ['enumerate', 'pkg:npm/demo'], path: '/v1/enumerate' },
      {
        argv: ['inspect', 'pkg:npm/demo@1.0.0'],
        path: '/v1/inspect',
      },
      { argv: ['solve', '--input', '-'], path: '/v1/solve', input: {} },
      { argv: ['explain', digest], path: '/v1/explain' },
      {
        argv: ['materialize', 'pkg:npm/demo@1.0.0'],
        path: '/v1/materialize',
      },
      { argv: ['verify', '--input', '-'], path: '/v1/verify', input: {} },
      {
        argv: ['pack', '--input', '-'],
        path: '/v1/openpacker/pack',
        input: {},
      },
      {
        argv: ['publish', '--input', '-'],
        path: '/v1/openpacker/publish',
        input: {},
      },
      {
        argv: ['receipt', 'inspect', digest],
        path: `/v1/receipts/sha256/${'a'.repeat(64)}`,
      },
      {
        argv: ['receipt', 'verify', '--input', '-'],
        path: '/v1/verify',
        input: signedReceipt,
      },
      {
        argv: ['catalog', 'import', '--input', '-'],
        path: '/v1/openpacker/catalog/import',
        input: {},
      },
      {
        argv: ['catalog', 'snapshot', '--input', '-'],
        path: '/v1/openpacker/catalog/snapshot',
        input: {},
      },
      {
        argv: ['lifecycle', 'apply', '--input', '-'],
        path: '/v1/openpacker/lifecycle/apply',
        input: {},
      },
    ];

    for (const item of cases) {
      let requested = '';
      vi.stubGlobal('fetch', async (url: string | URL | Request) => {
        requested = new URL(url.toString()).pathname;
        return Response.json({ digest, decision: 'allow' });
      });
      const output = io();
      if (item.input !== undefined)
        output.stdin = Readable.from([JSON.stringify(item.input)]);
      expect(await runCli([...item.argv, '--json'], output)).toBe(
        EXIT_CODES.success,
      );
      expect(requested).toBe(item.path);
      expect(output.out).toContain(digest);
      vi.unstubAllGlobals();
    }
  });

  it('maps verify decisions to fail-closed exit codes', async () => {
    const cases: Array<{ body: unknown; exit: number }> = [
      { body: { decision: 'allow', evidence: [] }, exit: EXIT_CODES.success },
      {
        body: {
          decision: 'deny',
          evidence: [{ status: 'invalid' }],
        },
        exit: EXIT_CODES.verificationFailed,
      },
      {
        body: {
          decision: 'deny',
          evidence: [{ status: 'policy-denied' }],
        },
        exit: EXIT_CODES.policyDenied,
      },
      {
        body: { decision: 'indeterminate', evidence: [] },
        exit: EXIT_CODES.unavailable,
      },
      { body: { evidence: [] }, exit: EXIT_CODES.internal },
    ];
    for (const item of cases) {
      vi.stubGlobal('fetch', async () => Response.json(item.body));
      const output = io();
      output.stdin = Readable.from(['{}']);
      expect(await runCli(['verify', '--input', '-', '--json'], output)).toBe(
        item.exit,
      );
      vi.unstubAllGlobals();
    }
  });

  it('redacts secrets from human output', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        digest: `sha256:${'a'.repeat(64)}`,
        authToken: 'secret',
      }),
    );
    const output = io();
    expect(await runCli(['normalize', 'pkg:npm/demo'], output)).toBe(
      EXIT_CODES.success,
    );
    expect(output.out).toContain('[REDACTED]');
    expect(output.out).not.toContain('secret');
  });

  it('exports a schema-valid lock and a reference-consistent CycloneDX SBOM', async () => {
    const solve = solveResponse();
    const lockOutput = io();
    lockOutput.stdin = Readable.from([JSON.stringify(solve)]);
    expect(
      await runCli(['export', 'lock', '--input', '-', '--json'], lockOutput),
    ).toBe(EXIT_CODES.success);
    const lock = JSON.parse(lockOutput.out);
    expect(lock.externalRefs).toEqual([
      { type: 'did', locator: 'did:example:consumer' },
      { type: 'epoch-event', locator: 'urn:epoch:event:fixture' },
    ]);

    const sbomOutput = io();
    sbomOutput.stdin = Readable.from([JSON.stringify(solve)]);
    expect(
      await runCli(['export', 'sbom', '--input', '-', '--json'], sbomOutput),
    ).toBe(EXIT_CODES.success);
    const sbom = JSON.parse(sbomOutput.out);
    expect(sbom.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const componentRefs = new Set(
      sbom.components.map(
        (component: { 'bom-ref': string }) => component['bom-ref'],
      ),
    );
    const knownRefs = new Set(componentRefs);
    knownRefs.add(sbom.metadata.component['bom-ref']);
    expect(sbom.dependencies[0]?.ref).toBe(sbom.metadata.component['bom-ref']);
    expect(sbom.dependencies[0]?.dependsOn.length).toBeGreaterThan(0);
    for (const dependency of sbom.dependencies) {
      expect(knownRefs.has(dependency.ref)).toBe(true);
      for (const reference of dependency.dependsOn)
        expect(knownRefs.has(reference)).toBe(true);
    }
  });

  it('fails closed for invalid lock output and a missing demo module', async () => {
    const invalid = solveResponse() as {
      normalizedRequest: { target?: unknown };
    };
    delete invalid.normalizedRequest.target;
    const lockOutput = io();
    lockOutput.stdin = Readable.from([JSON.stringify(invalid)]);
    expect(
      await runCli(['export', 'lock', '--input', '-', '--json'], lockOutput),
    ).toBe(EXIT_CODES.invalidInput);
    expect(JSON.parse(lockOutput.err).error.message).toContain(
      'invalid lockfile',
    );

    const output = io();
    expect(await runCli(['demo', '--json'], output)).toBe(EXIT_CODES.usage);
    expect(JSON.parse(output.err).error.message).toContain('module');
  });

  it('documents serve and demo module options', async () => {
    const output = io();
    expect(await runCli(['--help'], output)).toBe(EXIT_CODES.success);
    expect(output.out).toContain('--operations-module <path>');
    expect(output.out).toContain('--workflow-module <path>');
  });
});

function solveResponse(): unknown {
  const digest = (character: string) => ({
    algorithm: 'sha256',
    value: character.repeat(64),
  });
  const externalRefs = [
    { type: 'epoch-event', locator: 'urn:epoch:event:fixture' },
    { type: 'did', locator: 'did:example:consumer' },
  ];
  const selected = ['a', 'b'].map((character, index) => ({
    nodeId: `sha256:${character.repeat(64)}`,
    identity: {
      name: `component-${character}`,
      exactPurl: `pkg:npm/component-${character}@1.0.${index}`,
      externalRefs: index === 0 ? externalRefs : [],
    },
    normalizedVersion: `1.0.${index}`,
    artifacts: [],
  }));
  return {
    normalizedRequest: {
      requirements: [
        {
          id: 'root',
          expression: {
            type: 'package',
            purl: 'pkg:npm/component-a',
            vers: 'vers:npm/>=1.0.0',
          },
          kind: 'runtime',
          optional: false,
          source: { type: 'overlay', uri: 'urn:fixture:root' },
          authority: 'fixture',
          semanticLoss: [],
        },
      ],
      target: {
        os: 'linux',
        architecture: 'x86_64',
        runtimes: {},
        capabilities: [],
      },
      semantics: { profile: 'prex-calculus-subset-v1' },
      objectives: ['satisfy-hard-constraints'],
    },
    selected,
    solution: {
      dependencyEdges: [
        {
          fromNodeId: selected[0]!.nodeId,
          requirementId: 'dependency',
          toNodeId: selected[1]!.nodeId,
          witnessType: 'package',
        },
      ],
      sourceSnapshotDigests: [],
      solutionDigest: digest('c'),
    },
    unsignedReceipt: {
      lifecycleRoot: digest('d'),
      policyDigest: digest('e'),
      externalRefs: [externalRefs[0]],
    },
    signedReceipt: { receiptDigest: digest('f') },
  };
}
