# sdlc state — sandbox security hardening

- Initiative: close audit gaps (C1/C2/H1–H4/M1–M4) as one-shot swarm
- Phase: **implementation → ship**
- Trunk base: `9c71d2b`
- Issues: #63–#72

## Delivered on this branch

- Profiles: `package-exec` | `host-install` | `ambient`
- Minimal bwrap binds for package-exec (no fat RO `/`)
- Minimal PATH; project RO by default for opmx
- Shim re-entry via opmx / ambient hatch
- Host-install limited containment honesty
- Strict lifecycle allowlist default
- Must-pass adversarial tests
- Timeouts (default 600s)
