/**
 * Behavior specifications for the supply-chain policy journey. These pin
 * user-visible promises about when installation proceeds and when it refuses,
 * phrased Given/When/Then. They complement the package unit tests by
 * exercising the journey across policy + opm-project public APIs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { evaluatePolicy, policyDocumentFromPolicyInput } = await import(
  '@openpacker/policy'
);
const { captureFactsFromSourceUri, defaultSupplyChainPolicyInput } =
  await import('@openpacker/opm-project');

const evaluationTime = '2026-08-04T00:00:00.000Z';

test('Given a direct https tarball with no registry evidence, when the default policy evaluates it, then installation is refused as indeterminate', async () => {
  // Given an operator running the default supply-chain policy
  const policy = policyDocumentFromPolicyInput(defaultSupplyChainPolicyInput());

  // When a dependency resolves to a bare https tarball — no registry behind
  // it, so no lifecycle evidence can exist
  const facts = captureFactsFromSourceUri(
    'pkg:npm/demo@1.0.0',
    'https://cdn.example.invalid/demo/-/demo-1.0.0.tgz',
    { evaluationTime },
  );

  // Then the product refuses to assume eligibility: the decision is
  // indeterminate, never silently allowed.
  const result = await evaluatePolicy(policy, facts);
  assert.equal(result.decision, 'indeterminate');
  const lifecycle = result.checks.find(
    (check) => check.code === 'lifecycle.eligibility',
  );
  assert.equal(lifecycle?.status, 'not-provided');
});

test('Given a local path source, when the default policy evaluates it, then no registry lifecycle gate applies and it may proceed', async () => {
  // Given the same default policy
  const policy = policyDocumentFromPolicyInput(defaultSupplyChainPolicyInput());

  // When the dependency is a local path the operator placed there themselves
  const facts = captureFactsFromSourceUri(
    'pkg:npm/local-tool@1.0.0',
    'file:../local-tool',
    { evaluationTime },
  );

  // Then lifecycle evidence is not demanded of a source that has no registry
  // by construction.
  const result = await evaluatePolicy(policy, facts);
  const lifecycle = result.checks.find(
    (check) => check.code === 'lifecycle.eligibility',
  );
  assert.equal(lifecycle?.status, 'valid');
});

test('Given the default policy, when nothing is configured, then sandboxing is mandatory and host-ambient installs are refused', () => {
  // Given a fresh project with no policy customisation
  const input = defaultSupplyChainPolicyInput();

  // Then containment is the default, not an opt-in.
  assert.equal(input.sandboxMode, 'fail-closed');
  assert.equal(input.sandboxRequired, true);
  assert.equal(input.allowHostUnsandboxedInstall, false);
  assert.equal(input.allowLifecycleScripts, false);
});
