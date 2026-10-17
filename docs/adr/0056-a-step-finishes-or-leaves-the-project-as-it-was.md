# ADR 0056: A step finishes or leaves the project as it was

- Status: Accepted
- Date: 2026-10-17
- Relates: [0027](0027-environment-generations.md) (generations: a step that is
  put back takes its generation with it),
  [0048](0048-one-copy-per-machine-and-a-node_modules-node-can-resolve.md) (the
  layout whose writes make a hard-link copy enough),
  [0050](0050-workspace-member-links.md) (entries opm did not write stay in
  node_modules, which rules out swapping the whole directory)

## Context

`opm add`, `opm sync` and `opm update` write opm.toml, `opm.lock.json`,
`package.json`, opm's state under `.opm/`, and `node_modules`. They wrote them
in whatever order the code happened to reach them:

- `opm sync` wrote the lock before installing it.
- `opm update --latest` wrote opm.toml before it had resolved anything.
- `opm add` wrote both before installing.

Three kinds of failure were seen while installing real projects:

- an archive the materializer refuses (one path listed twice with different
  bytes: DUPLICATE_PATH);
- a place in node_modules the layout cannot write once linking has started (a
  file where `.bin` must be a directory: ENOTDIR);
- a process killed part way.

Each of them left a lock, and for an update an opm.toml, describing a closure
that was never installed, and the second and third left a node_modules half way
between the two. The next `opm sync` then read a half-written opm.toml ("Invalid
TOML assignment at line 1").

## Decision

1. **One step for the three commands** (`commitInstall`, `install-commit.ts`).
   Every package of the lock goes into the store first (`installFromLock`'s
   `beforeLinking`). The store is content-addressed and nothing reads an entry
   no lock names, so a package that cannot be fetched, verified or extracted
   stops the step before anything outside the store has changed.

2. **Then the project is copied, then written** (`project-rollback.ts`).
   - Before opm.toml (add, update --latest) and the lock are written, the step
     keeps a copy under `.opm/.rollback-<pid>-<uuid>`.
   - Small files are kept by their bytes: opm.toml, the lock, `package.json`,
     `package-lock.json`, `.opm/project.json`, `.opm/native.json` and
     `.opm/environment.json`.
   - `node_modules` is kept as a tree of hard links to the same inodes. opm's
     `.opm/bin`, `.opm/links` and `.opm/generations` are copied.
   - A failure while linking or laying out node_modules puts all of it back.
     Success discards the copy.

3. **A recorded copy, not a staged node_modules swapped in.** The layout writer
   works in place against its own record (ADR 0048), and node_modules can hold
   entries opm did not write: workspace links (ADR 0050), and other tools'
   files. A swapped directory would drop those. Every write the layout makes
   replaces a name rather than writing into a file that is there:
   - package directories are staged and renamed;
   - files are hard links to the store;
   - shims and records are written to a temporary name and renamed.

   So a hard-link copy taken before still holds the old tree. It costs a link
   per file, not the bytes: about 1 s to take and 1 s to discard for a
   9,539-file node_modules on a busy four-core machine, where `cp -al` takes
   0.27 s.

4. **The copy is on disk with a record of whose it is** (`rollback.json`,
   `rollback-record.ts`).
   - The owner is recorded where its pid means something (`process-owner.ts`):
     pid, hostname, and on Linux the start time (`/proc/<pid>/stat` field 22),
     the PID namespace (`/proc/self/ns/pid`), the boot id and the machine id.
   - The record names no path. It holds one row per entry of two fixed tables,
     the files and the trees above, by position: whether each existed, and for a
     file the sha256 and mode it had. The step also records the sha256 of the
     opm.toml and lock it is about to write.
   - It holds a state, `copying` until every file and tree is kept and then
     `ready`. A copy that cannot be finished is removed at once.
   - A copy is renamed to `….discard` before it is removed, so a copy half
     removed is never taken for one to restore from.
   - Putting the project back is safe to repeat: a tree already moved back is
     skipped, and files are renamed into place whole.

5. **One step at a time, and a killed step is finished by the next one**
   (`project-step.ts`, `step-lock.ts`, `rollback-recovery.ts`).
   - Every library function that changes a project runs as a step on the root it
     was given: `initProject`, `importNativeProject`, `addPackage`,
     `removePackage`, `syncProject`, `updateProject`, `installProject`,
     `uninstallProject`, `switchGeneration`, `collectGarbage` and
     `installFrozen`. The CLI keeps no list: each of its commands that changes a
     project (`init`, `import`, `add`, `remove`, `sync`, `update`, `install`,
     `uninstall`, `ci`, `rollback`, `gc`, `packslip pin --write` and `approve`)
     is one such step. A host package's `add`, and a dry-run `gc`, change no
     project and take none. A step inside a step neither locks nor recovers
     again.
   - A step first takes the project's lock: it writes `.opm/step-<uuid>.lock`
     with `O_EXCL`, naming its owner, and holds the lock when no other such file
     names an owner that may be running. Otherwise it removes its file, waits
     (10 s by default; the CLI says for whom) and refuses with `PROJECT_BUSY`. A
     file whose owner is gone is removed by whoever sees it; its name is that
     owner's alone, so this never takes a live step's lock. Two steps cannot
     both hold the lock, since each listed the others after its own file
     existed.
   - Holding the lock, the step recovers what is in its own `.opm`, and nowhere
     else (`opm ci --path <dir>` recovers `<dir>`, never a parent):
     - a copy that is not a directory of this user, or is a link, or a `.opm`
       that is not a directory, stops the step (`UNSAFE_PATH`);
     - a record that cannot be read for any reason but ENOENT stops it
       (`UNAVAILABLE`), and one of another shape or version stops it too
       (`INVALID_ROLLBACK`), the copy kept either way;
     - a copy whose owner may still be running stops it (`PROJECT_BUSY`). An
       owner with this machine's machine id and hostname and another boot id is
       gone: it ran before this machine last started. Otherwise the owner counts
       as running when its hostname, machine id, boot id or PID namespace
       differs from this process's or is known on one side only; when its pid
       answers signal 0 with the start time recorded (or none was); and when the
       pid answers with EPERM;
     - a `ready` copy that was not being discarded means the project may be half
       way, and it is put back, unless opm.toml or the lock holds neither what
       the copy kept nor what the step was about to write: someone wrote it
       since, so the step stops (`ROLLBACK_CONFLICT`) and the copy is kept;
     - a copy with no record yet, a `copying` copy (the step had not started
       writing) or a `….discard` copy (the step had finished) is removed.
   - Each copy recovered is told to `step.onRecovered`; the CLI says it in one
     line on stderr: "opm: put the project back as it was before a step that
     process 4242 did not finish, and removed .opm/.rollback-…".

## Consequences

- A failure at any point of `add`, `sync` or `update`, a kill included, ends
  with the project as it was before the step, at the latest after the next step
  that changes it.
- Each of those steps pays for the copy, a link per file of node_modules.
- A generation recorded by a step that is put back is removed with it. The
  ledger of ADR 0027 records environments that were installed, and that one was
  not.
- The store keeps what a failed step materialised; `opm gc` removes entries no
  generation uses.
- Two opm commands on one project run one after the other. The second waits up
  to 10 s for the first, then stops with exit code 8 and names it.

Limits:

- The lock and the copies exclude steps of opm only, and only those that run
  through a step: a host that calls `installFromLock` or `writeManifestFile`
  itself, another tool, or an edit by hand is not excluded. The digests catch a
  later write to opm.toml or the lock; one to node_modules or `.opm` state alone
  is not seen, and would be undone.
- A step stops, rather than guess, at a copy or a lock whose owner it cannot
  judge (another machine, boot or PID namespace sharing the project). If that
  owner is really gone, a person removes the file the message names.
- The earlier-boot rule trusts the machine id. Two machines cloned from one
  image that kept its `/etc/machine-id`, with one hostname and a shared project,
  would each take the other's live step for one of an earlier boot.
- Where no start time is available (macOS, Windows), a reused pid keeps a stale
  copy or lock waiting until that process ends. It is never a reason to touch a
  live one. Those platforms record pid and hostname only, and were not run.
- A lock file is written as it is created; one left empty by a process killed in
  between is taken for a live lock for 5 s, then removed.
- Only `add`, `sync` and `update` keep a copy. The other steps lock and recover
  first, but a kill part way through `install` (with a lock), `remove`,
  `uninstall`, `init`, `import`, `rollback`, `gc` or `ci` (ADR 0046) is not put
  back.
- The kill was exercised on Linux: with a child process that keeps its copy,
  starts the step's writes and is killed with SIGKILL
  (`rollback-recovery.test.ts`), and by the review's harness, which kills a step
  at each of its file-system calls and a recovery at each of its own.
