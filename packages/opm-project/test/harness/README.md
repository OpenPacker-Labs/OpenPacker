# Kill sweeps

`kill-sweep.mjs` kills a recovery, or a step, before each of its file-system
calls in turn (`kill-hook.mjs` counts open, cp, chmod, unlink, rmdir, utimes,
stat, readlink, realpath, copyFile, and the FileHandle writes, syncs, chmods and
truncates, as well as the calls the rollback code makes by name), runs the next
recovery (which waits up to 15 s: a kill between creating a lock file and
writing it leaves an empty file that is held for 5 s before it counts as a
leftover), and fails unless the project is exactly as it was before the killed
step, with no copy and no lock left (ADR 0056).

Build the package first (`npm run build -w packages/opm-project`), then:

```sh
node packages/opm-project/test/harness/kill-sweep.mjs recovery plain
node packages/opm-project/test/harness/kill-sweep.mjs recovery volume      # node_modules a volume
node packages/opm-project/test/harness/kill-sweep.mjs recovery bindfile    # opm.toml bind-mounted
node packages/opm-project/test/harness/kill-sweep.mjs recovery opmvolume   # .opm on a volume of its own
node packages/opm-project/test/harness/kill-sweep.mjs step                 # a step, at sampled calls
node packages/opm-project/test/harness/kill-sweep.mjs locked               # the same under the real lock
```

The mount layouts run under `unshare --mount` (as root, or through a user
namespace) and fail, never skip, on a machine that refuses both. They are not in
`npm test`: a sweep takes minutes. Run them before changing
`rollback-restore.ts`, `rollback-files.ts`, `rollback-recovery.ts` or
`project-rollback.ts`.
