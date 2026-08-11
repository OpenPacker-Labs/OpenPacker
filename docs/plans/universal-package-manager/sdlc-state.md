# sdlc-state: universal-package-manager

- **Initiative:** Make `opm` a package manager that works across every ecosystem
  it claims, rather than one that works for npm and describes the rest
- **Phase:** done
- **Trunk:** main
- **PRs:** #18–#29, #32–#36 — all squash-merged (see `dispatch-log.md`)

## Goal

`opm` could resolve and install npm packages. Everything else — OCI, PyPI,
NuGet, Cargo, Go, Maven, nix, apt, winget, Chocolatey — was either absent or
present in name only. The user's framing was that PREX exists so other package
managers plug into it, so the gap was not "add more adapters" but "make every
capability the adapters advertise actually reachable".

## What landed

**Registry reach.** OCI browsing and pinning (#18), then materialising registry
images into the project store (#32). Ephemeral execution straight from a
registry with no project (#19), then per-ecosystem executable discovery so
`opmx` runs Python console scripts and .NET tools, not only npm bins (#20, #24).

**Dependency resolution across the board.** Transitive resolution through the
PREX solver with the proof independently checked, plus a nix provider (#21);
installing the resolved closure rather than only what was named (#22); Python
transitive resolution for real (#29).

**System installers.** winget through the real CLI (#23), then nix, .NET and the
system installers made production-ready (#34).

**Lock import.** `requirements.txt` (#25), `pnpm-lock.yaml` (#27), `poetry.lock`
(#28) — nine native formats in total.

**The plug-in boundary.** A Registry Definition service index and a WIT adapter
world (#35), then discovery as the _only_ production path: concrete ecosystems
unbaked from core, codecs and catalogs and installers routed solely through the
adapter registry (#36).

## Decisions

1. **Adapters advertise, core dispatches.** No ecosystem is named in
   `opm-project`, `openpackerd` or `lock-import`. A missing resource type means
   unsupported, not "try anyway".
2. **Capture is not a solve.** Imported locks stay `native-capture-v1`; the
   solver's answers carry a proof that is checked, not trusted.
3. **Advertise only what the module can honour** (#36 follow-up in #37): a
   Registry Definition that claims search without a catalog export is a lie the
   host now refuses.

## Notable defects found and fixed en route

- `opm add pkg:npm/json@11.0.0` failed on `package/./lib/json.js`; `.` segments
  are dropped rather than refused (pre-existing).
- Windows-hostile paths (`CON`, `NUL`, `aux.txt`, trailing dots) were accepted
  by all three path validators; now refused on every platform (#26).
- The unauthenticated daemon HTTP bind surface was hardened (#33).

## Not verified

nix, winget and .NET tool _execution_ — none of those runtimes exist in this
environment. Discovery and the missing-runtime paths were verified against real
packages; execution was not.
