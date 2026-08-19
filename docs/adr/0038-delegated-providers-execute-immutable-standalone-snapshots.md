# ADR 0038: Delegated providers execute immutable standalone snapshots

- Status: Accepted
- Date: 2026-08-19
- Relates: [ADR 0036](0036-sandboxed-installs-and-execution.md),
  [ADR 0037](0037-delegated-pack-providers-plan-host-executes.md)

## Context

ADR 0037 separates provider planning from host-controlled execution. Selecting
an operator-approved absolute executable path is necessary but insufficient:
checking or hashing a file and later executing its pathname permits swaps or
in-place mutation between those operations. Preserving the configured path in
the jail would also expose its runtime directory and make sibling code or
resources part of the effective executable authority.

## Decision

A delegated provider executable is a standalone authority. The host opens the
operator-approved absolute source without following links, enforces a practical
size bound, copies and hashes the approved bytes into a private immutable
snapshot, and retains a read-only descriptor through pack, cleanup, and identity
commands. The sandbox copies those bytes directly from the inherited descriptor
into a private mode-`0500` executable and executes that private path. Ambient
execution and backends that cannot consume the descriptor fail closed. The
reference Linux implementation requires `O_TMPFILE`; it does not fall back to a
named writable temporary executable when unnamed storage is unavailable.

The configured path remains the provider selection and receipt source path. The
receipt digest identifies the exact immutable snapshot that executed. The
configured path is not an accepted `argv[0]` contract, and its parent directory
is not implicitly readable. This decision supersedes any configured-path
`argv[0]` expectation inferred from ADR 0037 or earlier implementations.

## Consequences

Providers cannot rely on sibling modules or resources, relative loader paths, or
runtime directory layouts such as nvm. Operators must approve a self-contained
executable, bundle, or standalone wrapper. This deliberately smaller boundary
avoids recursively snapshotting a runtime tree and prevents a broader read
authority from hiding or replacing the approved executable.

Receipts remain intelligible to operators because they name the configured
source path, while verification remains byte-exact because the associated digest
is over the private snapshot. Path or byte mutation can make an operation fail
closed, but cannot select different executable bytes.
