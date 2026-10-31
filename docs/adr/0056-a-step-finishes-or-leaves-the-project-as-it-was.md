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
     `.opm/bin`, `.opm/links` and `.opm/generations` are copied. Each directory
     of a kept tree is made private, filled, and then given the mode of the one
     it keeps (`chmod`, not `mkdir`'s mode, which the umask narrows and which
     drops setgid), so a tree is put back with its directories' modes.
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
   `rollback-record.ts`, `rollback-files.ts`, `rollback-restore.ts`).
   - The owner is recorded where its pid means something (`process-owner.ts`):
     pid, hostname, and on Linux the start time (`/proc/<pid>/stat` field 22),
     the PID namespace (`/proc/self/ns/pid`), and the boot id and the machine id
     as **digests**, never the ids: machine-id(5) calls the machine id
     confidential, and the record sits in a project that is committed, cached
     and shared. A digest is `d1-` and 32 hex digits of an HMAC-SHA-256 keyed by
     what it names (`opm.owner.machine.v1`, `opm.owner.boot.v1`). Reading a
     record never rewrites a field into a digest: another holder that writes its
     own values (a raw id, a digest of its own) compares them as written. The
     hostname is kept as `[A-Za-z0-9._-]`, anything else as `_`, so that a lock
     cannot write to a terminal. The same holds for every name in `.opm` and
     every path a record names that a message shows: control characters, the
     escape among them, are printed as `?` (one function, `printable`).
   - The record names no path to put back into; every path is rebuilt from the
     tables. It does name the project it was made in: the root directory's
     device and inode (a rename within a file system keeps them, a copy does
     not) and its real path (a project restored to the same place keeps it). A
     copy is put back only into a project that agrees on either; one that
     arrived in another project's `.opm` (a `cp -a`, a CI cache, an archive) is
     `INVALID_ROLLBACK` in plain words, and is removed, with nothing else
     touched, by `opm recover --abandon-step`. If the project it names has this
     very `.opm` (a bind mount or volume two projects share), the copy is that
     project's own and is neither put back nor removed from here.
   - Beyond that it names no path. It holds one row per entry of two fixed
     tables, the files and the trees above, by position. A file row has the
     sha256 and the mode of the file; a tree row says it was a directory, or
     absent. The step also records the sha256 of the opm.toml and lock it is
     about to write, or of opm.toml as it is for a step that leaves it alone
     (`opm sync`).
   - A link is kept as a link. A project file that is a symbolic link is a row
     with its target (and the digest of the target), never read through; a
     `node_modules` that is a link is a tree row holding its target, and what is
     behind it is not kept. A regular file is read from a handle that refuses a
     link, and its mode is the handle's. Anything else (a directory where a file
     goes, a socket) is refused with `UNSAFE_PATH`.
   - It holds a state, `copying` until every file and tree is kept and then
     `ready`. A copy that cannot be finished is removed at once.
   - A copy is renamed to `….discard` before it is removed, so a copy half
     removed is never taken for one to restore from.
   - Putting the project back checks everything before it changes anything: each
     kept file is opened no-follow, has one name (`nlink` 1), is no larger than
     64 MiB (a larger one is refused before it is read, here and when a copy is
     taken) and hashes to its recorded digest, a kept tree is a directory, and
     no project file has become a directory. A link or a second name in the copy
     is `UNSAFE_PATH`; bytes that are not the recorded ones, a missing file, or
     a kept tree that is missing without the copy having begun to move it, are
     `ROLLBACK_CONFLICT`; nothing is written in either case.
   - Then each file is written whole to `.<name>.opm-restore` beside its name
     through the directory's handle, flushed (`fsync` of the file, not of the
     directory), and renamed over it: opm.toml is never empty or half written, a
     link at the name is replaced, a file that has other names is left as it is
     for them, and the mode is the recorded one. Every step, under its lock,
     first removes the `.<name>.opm-restore` names a putting back that was
     killed left, whether or not its copy is still there.
   - It is safe to repeat. A tree is marked (`trees/<i>.moving`, flushed) before
     anything is done to it; a kept tree that is gone with its mark was moved
     back, and one that is gone without is a copy that lost it and is refused.
   - **Mounts.** A `node_modules` that is a mount point (a Docker volume) cannot
     be removed or renamed over, and the copy of it, made across file systems,
     is a copy of the bytes rather than of links (each `add`, `sync` and
     `update` pays for the whole tree). The directory is emptied and the kept
     tree copied in. The kept tree is never touched by that: it goes with the
     rest of the copy, which is renamed to `….discard` first, so a kill at any
     point finds it whole and the next recovery does the whole copy again, never
     from a half-removed one. A tree that has a mount point inside it
     (`node_modules/.cache` as a volume) is refused before anything is removed,
     since emptying it would take the siblings and then stop at the mount. A
     file bind-mounted into the project (a name a rename cannot replace) is
     written in place, after the copy is marked (`files/<i>.putting`) so that a
     write cut short is finished by the next putting back and not taken for a
     conflict. Anything else the file system refuses (a read-only volume, a full
     disk) is `UNAVAILABLE` naming the path, why, that the copy is kept and the
     project may be part way back, and what to do: fix it and run `opm recover`,
     or remove the copy, which leaves the project part way through the step that
     left it (`opm sync` finishes that step). Never an errno or a call.

5. **One step at a time, and a killed step is finished by the next one**
   (`project-step.ts`, `step-lock.ts`, `rollback-recovery.ts`,
   `step-abandon.ts`).
   - Every library function that changes a project runs as a step on the root it
     was given: `initProject`, `importNativeProject`, `addPackage`,
     `removePackage`, `syncProject`, `updateProject`, `installProject`,
     `uninstallProject`, `switchGeneration`, `collectGarbage` and
     `installFrozen`. The CLI keeps no list: each of its commands that changes a
     project (`init`, `import`, `add`, `remove`, `sync`, `update`, `install`
     with or without `--frozen`, `uninstall`, `ci`, `rollback` with or without
     `--to`, `gc`, `recover`, `packslip pin --write` and `approve`) is one such
     step. A host package's `add`, and a dry-run `gc`, change no project and
     take none. A step inside a step neither locks nor recovers again.
   - A step works on the directory the project is in, whatever name it was
     reached by (a symbolic link to it, a bind mount of it); the lock and the
     recovery are of that directory.
   - A step first takes the project's lock: it writes `.opm/step-<id>.lock` with
     `O_EXCL`, naming its owner, and holds the lock when no other such file
     names an owner that may be running. Otherwise it removes its file, waits
     and refuses with `PROJECT_BUSY`, naming the holder. The wait is 10 s, or
     `--wait <ms>` / `OPM_STEP_WAIT_MS`: whole milliseconds from 0 to an hour,
     anything else is `INVALID_SPEC`. A file whose owner is gone is removed by
     whoever sees it; its name is that owner's alone, so this never takes a live
     step's lock. Two steps cannot both hold the lock, since each listed the
     others after its own file existed. A project opm may not write to (a
     read-only volume) stops here with `UNAVAILABLE`, saying which `.opm` and
     why, and nothing changed.
   - Holding the lock, the step recovers what is in its own `.opm`, and nowhere
     else (`opm ci --path <dir>` recovers `<dir>`, never a parent):
     - a copy that is not a directory of this user, or is a link, or a `.opm`
       that is not a directory, stops the step (`UNSAFE_PATH`);
     - a record that cannot be read for any reason but ENOENT stops it
       (`UNAVAILABLE`), and one of another shape or version stops it too
       (`INVALID_ROLLBACK`), the copy kept either way;
     - a copy whose owner may still be running stops it (`PROJECT_BUSY`). The
       rule is `process-owner.ts` and is stated in its header: an owner of this
       machine (machine id and hostname) and another boot has ended; an owner
       whose hostname, machine id, boot id or PID namespace differs from this
       process's, or is known on one side only, cannot be judged and counts as
       running; one unreadable on both sides agrees, so a host that hides a
       field is not immortal. Where the place agrees the pid decides: free
       (ESRCH) is gone; a zombie or dead process (`/proc` state Z or X) is gone,
       unless it leads threads that still run (more than one entry in
       `/proc/<pid>/task`), which is the process, or the threads cannot be
       listed, which is not certain; a start time that differs from the recorded
       one is gone (EPERM does not settle it either way); an unreadable start
       time is running;
     - a `ready` copy that was not being discarded means the project may be half
       way, and it is put back, unless opm.toml or the lock holds neither what
       the copy kept nor what the step was about to write, or package.json or
       package-lock.json holds neither what the copy kept nor one of the
       contents the step told the copy it was about to write (below): someone
       wrote it since, so the step stops (`ROLLBACK_CONFLICT`) and the copy is
       kept. Remove the copy to keep the project as it is now;
     - a copy with no record yet, a `copying` copy (the step had not started
       writing) or a `….discard` copy (the step had finished) is removed.
   - Each copy recovered is told to `step.onRecovered`; the CLI says it in one
     line on stderr: "opm: put the project back as it was before a step that
     process 4242 did not finish, and removed .opm/.rollback-…".
   - **package.json and package-lock.json are told to the copy.** The native
     projection writes them late, through `writeFileAtomic`
     (`@openpacker/project-io`). Before each such write the step adds the digest
     of what the file is about to hold to the copy's record (`also`, the
     last 32) and replaces the record durably (`rollback-journal.ts`, through
     `observeWrites`, which `writeFileAtomic` awaits). So a hand edit or an
     `npm install` between a kill and the next step is not taken for the step's
     work: it is `ROLLBACK_CONFLICT`, not reverted. `node_modules` is the one
     tree that is not guarded.
   - **A step that cannot be judged has a way out**
     (`opm recover --abandon-step <id> [--force]`, `abandonStep`). A container
     restarted over a project, a reused CI workspace or a changed host name
     leaves a lock and a copy whose owner is in another PID namespace, boot or
     host. The refusal names the command, not a forced one. What the operator is
     told, and asked, depends on what opm can know of the owner:
     - running here (its pid answers in this PID namespace), or this process:
       `STEP_ALIVE`, exit 8, always, `--force` or not;
     - provably dead (an earlier boot of this machine, or a pid that is free
       here): done, as ordinary recovery would;
     - of another place: `PROJECT_BUSY`, exit 8, until `--force`. The refusal
       names the owner, the file and when it was written, and says what being
       wrong costs: if that step is running it goes on writing the project with
       its lock gone and its work undone. `opm --help` says the same;
     - a lock that does not say who holds it (empty, cut short, from a newer
       opm): the same, with its own cost (other steps may run on the project,
       and if that step is running it writes without a lock); with `--force`
       only that lock file is removed, no copy is put back, and the command says
       so. It is named by the id its file name carries. A lock that could not be
       read for the system's own reason (no descriptors, an I/O error, gone or
       changed as it was read) is not a lock that says nothing: that is
       `UNAVAILABLE`, nothing changed, run again;
     - a copy made in another project: removed, nothing else touched, no
       confirmation, even if its owner runs here, unless that project shares
       this `.opm`. The refusal that leads here says what it is for a project
       that was moved or restored from a backup as well (new inodes, another
       path): the step that made the copy was never finished here, removing the
       copy keeps the project as it is, and `opm sync` finishes the step.

     Once confirmed, opm removes the locks of that owner and recovers its copies
     as above, and prints what it did; it does not touch another owner's lock or
     copy, which still stops the step.

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
- Two opm commands on one project run one after the other. The second waits for
  the first (10 s by default), then stops with exit code 8 and names it.
- A step this machine cannot see no longer needs files edited by hand:
  `opm recover --abandon-step <id>`.

Limits:

- The lock and the copies exclude steps of opm only, and only those that run
  through a step: a host that calls `installFromLock` or `writeManifestFile`
  itself, another tool, or an edit by hand is not excluded.
- opm.toml, the lock, package.json and package-lock.json are guarded against a
  later write, and only for a step that keeps a copy (`add`, `sync`, `update`).
  opm's `.opm/*.json` and `node_modules` are not: a copy puts them back as it
  kept them, so a write to them alone (an `npm install` into `node_modules`
  after a kill) is not seen, and would be undone. A write to package.json that
  does not go through `writeFileAtomic` is not told to the copy, and is refused
  as a conflict.
- A `node_modules` on a volume is copied, not linked, each time a copy is taken,
  and put back by copying; a project whose root is on a file system that cannot
  link pays the same.
- On a host with no machine id (most container images, which have no
  `/etc/machine-id`) the earlier-boot rule does not fire: a step killed there is
  recovered while the machine stays up, and after a reboot its lock and copy
  cannot be placed and need `opm recover --abandon-step`. The module header says
  how another holder (a run's scratch, a lease) maps its own record onto the
  owner rule, including a digest of the host name as the machine.
- A step stops, rather than guess, at a copy or a lock whose owner it cannot
  judge. `opm recover --abandon-step` is the way out; it is the operator's word
  that the step is dead, and a wrong word is a second writer.
- The earlier-boot rule trusts the machine id. Two machines cloned from one
  image that kept its `/etc/machine-id`, with one hostname and a shared project,
  would each take the other's live step for one of an earlier boot.
- Where no start time is available (macOS, Windows), a reused pid keeps a stale
  copy or lock waiting until that process ends, or until
  `opm recover --abandon-step`. It is never a reason to touch a live one. Those
  platforms record pid and hostname only, and were not run.
- A lock file is written as it is created; one left empty by a process killed in
  between is taken for a live lock for 5 s, then removed.
- Only `add`, `sync` and `update` keep a copy. The other steps lock and recover
  first, but a kill part way through `install` (with a lock), `remove`,
  `uninstall`, `init`, `import`, `rollback`, `gc` or `ci` (ADR 0046) is not put
  back, and records no digest, since there is no copy of theirs to put back.
- A `node_modules` that is a link is put back as that link; what is behind it is
  not kept. The file written to put a file back is flushed, its directory is
  not.
- A file system that folds case could not be run (this kernel refuses tmpfs
  `casefold` and an ext4 casefold image); every name opm makes is lower case,
  and the ids it compares itself are compared lower-cased.
- The kill was exercised on Linux: with a child process that keeps its copy,
  starts the step's writes and is killed with SIGKILL
  (`rollback-recovery.test.ts`), a sync killed while it links and a recovery
  killed before it renames a file (`rollback-atomic.test.ts`), and by a harness
  that kills a step at each of its file-system calls and a recovery at each of
  its own.
