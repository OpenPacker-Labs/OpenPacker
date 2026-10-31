# When opm is killed, and when two opm run at once

A command that changes a project (`init`, `import`, `add`, `remove`, `sync`,
`update`, `install`, `uninstall`, `ci`, `rollback`, `gc`, `packslip pin --write`
and `approve`) is one **step**. A step runs alone on its project, finishes what
a killed step left, and does its own work. What it guarantees, and where it
stops, is
[ADR 56](../adr/0056-a-step-finishes-or-leaves-the-project-as-it-was.md).

## What a step does

1. **It takes the project's lock**, `.opm/step-<id>.lock`. If another opm holds
   it, the step waits (10 s by default) and then stops with exit code 8, naming
   the holder.
2. **It finishes what a killed step left**: a `.opm/.rollback-…` copy whose
   owner has gone is put back over the project, and opm says so on stderr:
   `opm: put the project back as it was before a step that process 4242 did not finish`.
3. **It does its work.** `add`, `sync` and `update` first keep a copy of
   `opm.toml`, the lock, `package.json`, `package-lock.json`, `node_modules` and
   opm's own state, so a failure part way, or a kill, leaves the project as it
   was. A `node_modules` that is a volume is copied rather than linked, so each
   of those steps copies the whole tree.
4. **It drops the copy and releases the lock.**

`opm recover` does only steps 1 and 2.

## Waiting for another opm

`--wait <ms>`, or `OPM_STEP_WAIT_MS`, says how long a command waits for another
opm on the same project: whole milliseconds from 0 to 3600000, 10000 by default.
`--wait 0` gives up at once.

## When a step cannot be seen from here

opm decides that a step is gone only when it can tell: its process is not
running on this machine, in this PID namespace, in this boot, or this machine
has started again since. That last test needs a machine id (`/etc/machine-id`),
which most container images do not have: there, a step killed while the machine
stays up is recovered, and one left before a reboot is not, and needs
`--abandon-step` (below). A step it cannot see (a container restarted over a
project kept on a volume, a CI job on a reused workspace, another host sharing
the project, a host name that changed) counts as running, for ever. Every
command then stops with exit code 8:

```
opm: Another opm step is changing this project: process 1 on build-7 (.opm/step-9b1d….lock).
Run this again when it has finished (--wait <ms> waits longer). If that step is dead and cannot
be seen from here (another container or host), opm recover --abandon-step 9b1d… says what taking
it for dead costs and asks you to confirm.
```

The id is the one in the message: a lock's (`step-<id>.lock`) or a copy's
(`.rollback-<pid>-<id>`). Run it without `--force` and opm says what it costs
and does nothing:

```
opm recover --abandon-step 9b1d…
opm: opm cannot tell whether the step of process 1 on build-7 (.opm/step-9b1d….lock, written
3 hours ago) is still running: it is in another container, boot or host. Taking it for dead
removes its lock and puts the project back as it was before that step. If that step is running,
it keeps writing this project with its lock gone and its work undone. If you know it is not
running, add --force to the same command.
```

**Use `--force` only for a step that is dead.** If that step is in fact running
on another host, it goes on writing the project while this opm puts the copy
back over it, the project can end up half of one and half of the other, and the
step that is running has lost its lock and its work. Check the other container
or host first. With `--force`, opm removes the lock, puts the copy back (the
full recovery: nothing is put back over a file someone edited since), and prints
what it did. Run it once per step it names.

What opm can tell it does not ask about:

- a step running on this machine is never called dead, `--force` or not (exit
  code 8, `will not call a running step dead`);
- a step that is provably dead (its machine has started again, or its process is
  gone from this machine) is let go of without `--force`;
- a lock that does not say who holds it (empty, cut short, or written by a newer
  opm) is named by the id in its file name and needs `--force`, which removes
  that lock file and nothing else (a gone step's copy waits for the next step);
- a `.opm/.rollback-…` that arrived from another project (a copied `.opm`, a CI
  cache) is never put back here. `opm recover` stops at it and names it;
  `--abandon-step <id>` removes it and changes nothing else. The same holds for
  a project that was **moved to another volume or restored from a backup**
  (another device and inode, another path): the step that made the copy was
  never finished here, so removing the copy keeps the project as it is now, and
  `opm sync` finishes the step. If the other project shares this very `.opm` (a
  bind mount or a volume), the copy is its own and is left alone: run
  `opm recover` there.

## Refusals

| Code                | Exit | Meaning, and what to do                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PROJECT_BUSY`      | 8    | Another step holds the project, or left a lock or copy whose owner cannot be judged; or `--abandon-step` needs `--force`. Wait, or `opm recover --abandon-step <id>`.                                                                                                                                                                                                                                  |
| `STEP_ALIVE`        | 8    | `--abandon-step` named a step that is running on this machine.                                                                                                                                                                                                                                                                                                                                         |
| `UNAVAILABLE`       | 8    | opm could not create its lock (a read-only project), or the file system refused a file or a tree being put back (a read-only or busy volume, a full disk). A mount point inside `node_modules` is refused before anything is removed. The message names the path and why; the copy is kept, and the project may be part way back: fix it and run `opm recover`, or remove the copy and run `opm sync`. |
| `ROLLBACK_CONFLICT` | 3    | A copy cannot be put back: `opm.toml`, the lock, `package.json` or `package-lock.json` changed since the step (a hand edit, an `npm install`), a kept file is not what the copy recorded, or a kept tree is missing. Nothing is changed; remove the copy to keep the project as it is.                                                                                                                 |
| `INVALID_ROLLBACK`  | 3    | A copy's record is not one this opm writes, or the copy was made in another project. The copy is kept; remove it (for another project's, `--abandon-step` does).                                                                                                                                                                                                                                       |
| `INVALID_SPEC`      | 3    | `--abandon-step` was given something that is not an id, `--force` without it, or `opm recover` an option it does not take.                                                                                                                                                                                                                                                                             |
| `NOT_FOUND`         | 4    | No lock or copy has the id `--abandon-step` was given.                                                                                                                                                                                                                                                                                                                                                 |
| `UNSAFE_PATH`       | 7    | A copy or `.opm` is a link, belongs to another user, or holds a link or a file with other names where a file belongs. Nothing is changed.                                                                                                                                                                                                                                                              |

## What is not covered

- Only `add`, `sync` and `update` keep a copy. A kill part way through another
  step is not put back; it did lock, and it recovered first.
- opm.toml, the lock, `package.json` and `package-lock.json` are guarded against
  a later edit: a copy is not put back over one that was edited after a kill,
  and the step stops with `ROLLBACK_CONFLICT`. opm's `.opm/*.json` and
  `node_modules` are not, and a copy puts them back as they were: an
  `npm install` into `node_modules` between a kill and the next step is undone.
- A file larger than 64 MiB is not kept; the step stops before it changes
  anything.
- A `node_modules` that is a link is put back as that link; what is behind it is
  not kept.
- A tool that is not opm, or an edit by hand while a step runs, is not excluded
  by the lock.
- Verified on Linux. macOS and Windows record the process id and host name only,
  and were not run.
