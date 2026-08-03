# SDLC state — opm-package-manager

- **Phase:** closeout (finish in progress)
- **Started:** 2026-08-03
- **Branch:** `feat/opm-package-manager`
- **Trunk:** `origin/main`
- **PR:** (pending create)

## Session deliverables

- `opm` / `opmx` / `opkg` / `opkgm` package-manager CLI
- `@openpacker/opm-project` manifest/lock/store/install
- Offline fixtures + `examples/opm-project`
- ADR 0022 dual surface; README/docs front door for opm

## Decisions

- Primary UX is `opm`/`opmx`, not PREX protocol CLI alone
- Project-local `.opm/` store; no postinstall scripts by default
- Finish gate: local `agent:check` + git hooks (not remote CI)

## Local gates at finish

- `npm run agent:check:staged`
- `npm test --workspace @openpacker/opm-project`
- `npm test --workspace @openpacker/opm`
- `npm run test:docs`
