#!/usr/bin/env node
/**
 * Deterministic fuzz class for the opm auth-config parser.
 *
 * Truncated JSON, extra fields, HTTP origins, and secret-shaped values must
 * fail closed as OpmError. Never succeed with partial maps. Do not write
 * bearer material.
 */
import assert from 'node:assert/strict';
import { parseAuthConfig, OpmError } from '@openpacker/opm-project';

const seed = '0x5eedauth';
let state = Number(seed);
const random = () =>
  (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const integer = (maximum) => Math.floor(random() * maximum);
const pick = (values) => values[integer(values.length)];

const valid = JSON.stringify(
  {
    version: 1,
    origins: {
      'https://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
      'https://crates.internal.example': { tokenEnv: 'CARGO_TOKEN' },
    },
  },
  null,
  2,
);

const validParsed = parseAuthConfig(valid);
assert.equal(validParsed.version, 1);
assert.equal(
  validParsed.origins['https://npm.internal.example'].tokenEnv,
  'NPM_TOKEN',
);

let truncated = 0;
let malformed = 0;
let secrets = 0;
let httpOrigins = 0;

const mustFail = (raw, kind) => {
  try {
    parseAuthConfig(raw);
  } catch (error) {
    assert.ok(
      error instanceof OpmError,
      `${kind}: expected OpmError, got ${error?.name ?? typeof error}`,
    );
    assert.ok(
      error.code === 'INVALID_SPEC' || error.code === 'UNSAFE_PATH',
      `${kind}: unexpected code ${error.code}`,
    );
    return;
  }
  assert.fail(`${kind}: parser accepted invalid input`);
};

for (let i = 0; i < valid.length; i += 1) {
  mustFail(valid.slice(0, i), `truncated@${i}`);
  truncated += 1;
}

for (let i = 0; i < 64; i += 1) {
  const cut = integer(valid.length);
  const noise = String.fromCharCode(integer(128));
  mustFail(valid.slice(0, cut) + noise, `mutated@${cut}`);
  malformed += 1;
}

for (const raw of [
  '',
  '{',
  '[]',
  'null',
  '1',
  '"auth"',
  '{',
  '{"version":2,"origins":{}}',
  '{"version":"1","origins":{}}',
  '{"origins":{}}',
  '{"version":1}',
  '{"version":1,"origins":[]}',
  '{"version":1,"origins":null}',
  '{"version":1,"origins":{"https://npm.internal.example":"NPM_TOKEN"}}',
  '{"version":1,"origins":{"https://npm.internal.example":{"tokenEnv":"npm-token"}}}',
  '{"version":1,"origins":{"https://npm.internal.example":{"tokenEnv":"NPM_TOKEN"}},"extra":true}',
]) {
  mustFail(raw, 'malformed-vector');
  malformed += 1;
}

// A pin-only origin (no tokenEnv) is valid: it requires pinned artifacts
// without sending a token. See fd6e28e and auth-config.test.ts.
const pinOnly = parseAuthConfig(
  '{"version":1,"origins":{"https://npm.internal.example":{}}}',
);
assert.deepEqual(pinOnly.origins['https://npm.internal.example'], {});

for (const tokenEnv of [
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aa.bb',
  'Bearer abcdefghijklmnopqrstuvwxyz',
  pick([
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_abcdefghijklmnopqrstuvwxyz0123456789',
  ]),
]) {
  mustFail(
    JSON.stringify({
      version: 1,
      origins: {
        'https://npm.internal.example': { tokenEnv },
      },
    }),
    'secret-tokenEnv',
  );
  secrets += 1;
}

mustFail(
  JSON.stringify({
    version: 1,
    origins: {
      'https://npm.internal.example': {
        tokenEnv: 'NPM_TOKEN',
        token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      },
    },
  }),
  'secret-field',
);
secrets += 1;

mustFail(
  JSON.stringify({
    version: 1,
    origins: {
      'http://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
    },
  }),
  'http-origin',
);
httpOrigins += 1;

mustFail(
  JSON.stringify({
    version: 1,
    origins: {
      'https://user:super-secret@npm.internal.example': {
        tokenEnv: 'NPM_TOKEN',
      },
    },
  }),
  'userinfo-origin',
);
httpOrigins += 1;

console.log(
  `upm-auth-config fuzz: truncated=${truncated} malformed=${malformed} secrets=${secrets} httpOrigins=${httpOrigins} (seed ${seed})`,
);
