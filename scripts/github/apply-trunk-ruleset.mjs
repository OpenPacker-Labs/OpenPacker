#!/usr/bin/env node
/**
 * Apply trunk rulesets with `gh api`.
 *
 * main: squash merge queue, required check
 * "Trunk gate / Required merge queue gate", no force push.
 * integration and prod: only repository admins and the release GitHub App
 * (when OPENPACKER_RELEASE_APP_ID is set) bypass update, deletion, and
 * force-push rules, so writers cannot push or merge a pull request
 * (including a pull request from main).
 *
 * RepositoryRole actor_id 5 is the repository admin role.
 */
import { spawnSync } from 'node:child_process';

const CHECK = 'Trunk gate / Required merge queue gate';
const ADMIN_BYPASS = [
  { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
];

function releaseAppBypassActors() {
  const raw = process.env.OPENPACKER_RELEASE_APP_ID?.trim();
  if (!raw) return [];
  const actor_id = Number.parseInt(raw, 10);
  if (!Number.isFinite(actor_id)) {
    fail(
      `OPENPACKER_RELEASE_APP_ID must be a numeric GitHub App id, got: ${raw}`,
    );
  }
  return [{ actor_id, actor_type: 'Integration', bypass_mode: 'always' }];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printForbidden() {
  console.error(`GitHub returned 403 while applying repository rulesets.
Rulesets require a repository admin and a token with Administration: Read and write.

1. Open https://github.com/settings/personal-access-tokens/new
   Repository: OpenPacker-Labs/OpenPacker
   Permissions: Administration (read and write), Metadata (read)
   Or sign in as an admin with: gh auth login
2. Re-run: npm run ruleset:apply

main (trunk-main): squash merge queue, block force pushes, require
"${CHECK}".
integration (trunk-integration) and prod (trunk-prod): block updates,
deletions, and force pushes. Only repository admins (RepositoryRole id 5)
bypass. That blocks direct pushes and pull request merges from main.
Promotion workflows fast-forward those branches with a dedicated GitHub App
token (see docs/RELEASING.md). Set OPENPACKER_RELEASE_APP_ID when running
npm run ruleset:apply so that App is a ruleset bypass actor. GitHub refused
the built-in GitHub Actions integration bypass on this repository.`);
}

function gh(args, input) {
  return spawnSync('gh', args, { encoding: 'utf8', input });
}

function forbidden(result) {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return text.includes('HTTP 403') || text.includes('403 Forbidden');
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const view = gh([
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
  if (view.error) {
    if (view.error.code === 'ENOENT') {
      fail(
        'gh is not installed. Install GitHub CLI and authenticate as an admin.',
      );
    }
    fail(view.error.message);
  }
  if (view.status !== 0) {
    if (forbidden(view)) {
      printForbidden();
      process.exit(1);
    }
    fail(view.stderr || 'gh repo view failed');
  }
  return view.stdout.trim();
}

function api(method, endpoint, body) {
  const args = [
    'api',
    '--method',
    method,
    '-H',
    'Accept: application/vnd.github+json',
    endpoint,
  ];
  let input;
  if (body) {
    args.push('--input', '-');
    input = JSON.stringify(body);
  }
  const result = gh(args, input);
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail(
        'gh is not installed. Install GitHub CLI and authenticate as an admin.',
      );
    }
    fail(result.error.message);
  }
  if (result.status !== 0) {
    if (forbidden(result)) {
      printForbidden();
      process.exit(1);
    }
    process.stderr.write(result.stderr ?? '');
    process.stderr.write(result.stdout ?? '');
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}

function refCondition(branch) {
  return {
    ref_name: {
      include: [`refs/heads/${branch}`],
      exclude: [],
    },
  };
}

function mainRuleset() {
  return {
    name: 'trunk-main',
    target: 'branch',
    enforcement: 'active',
    conditions: refCondition('main'),
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          allowed_merge_methods: ['squash'],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          do_not_enforce_on_create: false,
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: CHECK }],
        },
      },
      {
        type: 'merge_queue',
        parameters: {
          check_response_timeout_minutes: 60,
          grouping_strategy: 'ALLGREEN',
          merge_method: 'SQUASH',
          max_entries_to_build: 5,
          min_entries_to_merge: 1,
          max_entries_to_merge: 5,
          min_entries_to_merge_wait_minutes: 0,
        },
      },
    ],
  };
}

function protectedBranch(name, branch) {
  return {
    name,
    target: 'branch',
    enforcement: 'active',
    conditions: refCondition(branch),
    bypass_actors: [...ADMIN_BYPASS, ...releaseAppBypassActors()],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'update',
        parameters: { update_allows_fetch_and_merge: false },
      },
    ],
  };
}

const repo = repository();
const listed = api(
  'GET',
  `repos/${repo}/rulesets?includes_parents=false&per_page=100`,
);
const rulesets = Array.isArray(listed) ? listed : [];
const desired = [
  mainRuleset(),
  protectedBranch('trunk-integration', 'integration'),
  protectedBranch('trunk-prod', 'prod'),
];

for (const ruleset of desired) {
  const existing = rulesets.find(
    (candidate) =>
      candidate.name === ruleset.name &&
      (candidate.source_type === 'Repository' ||
        candidate.source === repo ||
        candidate.source_type === undefined),
  );
  if (existing && existing.id) {
    const updated = api(
      'PUT',
      `repos/${repo}/rulesets/${existing.id}`,
      ruleset,
    );
    console.log(`updated ${ruleset.name} (${updated.id})`);
  } else {
    const created = api('POST', `repos/${repo}/rulesets`, ruleset);
    console.log(`created ${ruleset.name} (${created.id})`);
  }
}

console.log(`Required main check: ${CHECK}`);
console.log(
  'integration and prod accept pushes only from repository admins and, when configured, the release GitHub App bypass (OPENPACKER_RELEASE_APP_ID).',
);
if (process.env.OPENPACKER_RELEASE_APP_ID?.trim()) {
  console.log(
    `Release GitHub App bypass actor_id ${process.env.OPENPACKER_RELEASE_APP_ID.trim()} (Integration, always) is included on integration and prod.`,
  );
} else {
  console.log(
    'Set OPENPACKER_RELEASE_APP_ID when running ruleset:apply after creating the release GitHub App (see docs/RELEASING.md).',
  );
}
