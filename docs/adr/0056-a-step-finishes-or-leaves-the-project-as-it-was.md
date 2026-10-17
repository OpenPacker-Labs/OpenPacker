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

4. **The copy is on disk with a record of whose it is** (`rollback.json`).
   - The record holds the owner: pid, host, and, where the system says when a
     process started (Linux, `/proc/<pid>/stat` field 22), the start time.
   - It also holds a state, `copying` until every file and tree is kept and then
     `ready`, and which files and trees existed.
   - A copy is renamed to `….discard` before it is removed, so a copy half
     removed is never taken for one to restore from.
   - Putting the project back is safe to repeat: a tree already moved back is
     skipped, and files are rewritten whole.

5. **A killed step is finished by the next one** (`rollback-recovery.ts`).
   - Every step that changes a project runs recovery first:
     - in the library, `addPackage`, `removePackage`, `syncProject`,
       `updateProject` and `installProject`;
     - in the CLI, `add`, `remove`, `sync`, `update`, `install`, `uninstall` and
       `ci`.
   - A copy whose owner may still be running is never touched. The owner counts
     as running in three cases:
     - the pid answers signal 0, and the start time matches where one was
       recorded;
     - the pid answers with EPERM (another user's process);
     - the copy was made on another host, which nothing here can judge.
   - For the rest, a `ready` copy that was not being discarded means the project
     may be half way, and it is put back. A `copying` copy (the step had not
     started writing) or a `….discard` copy (the step had finished) is only
     removed.
   - The CLI says what it did in one line on stderr: "opm: put the project back
     as it was before a step that process 4242 did not finish, and removed
     .opm/.rollback-…".

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

Limits:

- A copy cut short between creating its directory and writing its record has
  only the pid in its name, and is judged on this host. A project on a disk
  shared between machines could have a live copy from elsewhere removed in that
  window, though never restored from.
- Where no start time is available (macOS, Windows), a reused pid keeps a stale
  copy waiting until that process ends. It is never a reason to touch a live
  copy.
- `opm ci` installs a package-lock.json through its own path (ADR 0046). It runs
  recovery first but takes no copy of its own.
- The kill was exercised on Linux, with a child process that keeps its copy,
  starts the step's writes and is killed with SIGKILL
  (`rollback-recovery.test.ts`). macOS and Windows were not run.
