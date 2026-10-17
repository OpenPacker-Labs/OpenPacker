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
   `opm.toml`, the lock, `package.json`, `node_modules` and opm's own state, so
   a failure part way, or a kill, leaves the project as it was.
4. **It drops the copy and releases the lock.**

`opm recover` does only steps 1 and 2.

## Waiting for another opm

`--wait <ms>`, or `OPM_STEP_WAIT_MS`, says how long a command waits for another
opm on the same project: whole milliseconds from 0 to 3600000, 10000 by default.
`--wait 0` gives up at once.

## When a step cannot be seen from here

opm decides that a step is gone only when it can tell: its process is not
running on this machine, in this PID namespace, in this boot, or this machine
has started again since. A step it cannot see (a container restarted over a
project kept on a volume, a CI job on a reused workspace, another host sharing
the project, a host name that changed) counts as running, for ever. Every
command then stops with exit code 8:

```
opm: Another opm step is changing this project: process 1 on build-7 (.opm/step-9b1d….lock).
Run this again when it has finished (--wait <ms> waits longer). If that step is dead and cannot
be seen from here (another container or host), run: opm recover --abandon-step 9b1d…
```

If that step is dead, say so:

```
opm recover --abandon-step 9b1d…
```

The id is the one in the message: a lock's (`step-<id>.lock`) or a copy's
(`.rollback-<pid>-<id>`). opm removes the lock, puts the copy back (the full
recovery: nothing is put back over a file someone edited since), and prints what
it did. Run it once per step it names.

**Use it only for a step that is dead.** opm cannot check it from here, and
refuses what it can see: a step whose process is running on this machine (exit
code 8, `will not call a running step dead`). A wrong answer costs a second
writer: if that step is in fact running on another host, it goes on writing the
project while this opm puts the copy back over it, and the project can end up
half of one and half of the other. Check the other container or host first.

## Refusals

| Code                | Exit | Meaning, and what to do                                                                                                                                   |
| ------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_BUSY`      | 8    | Another step holds the project, or left a lock or copy whose owner cannot be judged. Wait, or `opm recover --abandon-step <id>`.                          |
| `STEP_ALIVE`        | 8    | `--abandon-step` named a step that is running on this machine.                                                                                            |
| `ROLLBACK_CONFLICT` | 3    | A copy cannot be put back: `opm.toml` or the lock changed since the step (a hand edit), or a kept file is not what the copy recorded. Nothing is changed. |
| `INVALID_ROLLBACK`  | 3    | A copy's record is not one this opm writes. The copy is kept; remove it to keep the project as it is.                                                     |
| `UNSAFE_PATH`       | 3    | A copy or `.opm` is a link, belongs to another user, or holds a link or a file with other names where a file belongs. Nothing is changed.                 |

## What is not covered

- Only `add`, `sync` and `update` keep a copy. A kill part way through another
  step is not put back; it did lock, and it recovered first.
- opm.toml and the lock are guarded against a later edit; `package.json`,
  `package-lock.json` and opm's `.opm/*.json` are not, and a copy puts them back
  as they were.
- A `node_modules` that is a link is put back as that link; what is behind it is
  not kept.
- A tool that is not opm, or an edit by hand while a step runs, is not excluded
  by the lock.
- Verified on Linux. macOS and Windows record the process id and host name only,
  and were not run.
