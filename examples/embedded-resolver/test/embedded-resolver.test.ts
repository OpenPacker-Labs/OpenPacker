import { describe, expect, it } from 'vitest';
import type {
  EmbeddedBindings,
  EmbeddedSolveInput,
} from '@openpacker/embedded';
import { runEmbeddedResolver } from '../src/index.js';

describe('embedded resolver example', () => {
  it('refuses to return before the independent check and oracle run', () => {
    const calls: string[] = [];
    const bindings = {
      validate_universe_json: () => calls.push('validate'),
      solve_json: () => {
        calls.push('solve');
        return JSON.stringify({ selected: [] });
      },
      check_json: () => {
        calls.push('check');
        return JSON.stringify({ valid: true, diagnostics: [] });
      },
      brute_force_oracle_json: () => {
        calls.push('oracle');
        return JSON.stringify({ selectedNodeIds: [], assignmentsChecked: 1 });
      },
      canonicalize_json: (input: string) => input,
      digest_json: () =>
        JSON.stringify({ algorithm: 'sha256', value: '0'.repeat(64) }),
      version_satisfies: () => true,
      normalize_purl: (value) => value,
      parse_vers_json: () =>
        JSON.stringify({
          scheme: 'npm',
          original: '*',
          normalized: '*',
          ast: { type: 'any' },
          reversible: true,
          semanticLoss: [],
        }),
      verify_sha256: () => true,
      verify_receipt_digest: () => true,
    } satisfies EmbeddedBindings;

    const result = runEmbeddedResolver(bindings, {
      universe: {},
      request: {},
    } as EmbeddedSolveInput);
    expect(calls).toEqual(['validate', 'solve', 'check', 'oracle']);
    expect(result.oracle.assignmentsChecked).toBe(1);
  });
});
