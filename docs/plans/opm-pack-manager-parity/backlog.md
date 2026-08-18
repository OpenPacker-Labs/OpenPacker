# OPM pack manager parity backlog

## 01 — Isolation boundary

Status: implemented, independently approved, and fully verified.

Deliver a fail-closed, dependency-free container argv builder and regressions
for every required isolation control. Stop the existing Nix live test from
running merely because Nix is installed on the host.

## 02 — Manager cases and gates

Status: implemented, independently approved, and fully verified.

Map every standard pack target to format-specific offline assertions and to an
opt-in native manager recipe. Wire the offline suite into normal verification;
keep the native lane explicit because it requires preloaded platform images.
