# shellcheck shell=sh
#
# Rebuild the opm CLI when its sources are newer than its build output.
#
# The point of this directory is that `opm` on your PATH is always the code in
# this working tree, not a stale artifact from whenever you last remembered to
# build. The staleness check is a few stat calls (~17ms); the rebuild only runs
# when it has to, and is a warm turbo cache hit (~0.4s) when it does.
#
# Set OPENPACKER_DEV_NO_BUILD=1 to skip the check entirely.

openpacker_ensure_build() {
  openpacker_root=$1
  openpacker_target=$2

  if [ "${OPENPACKER_DEV_NO_BUILD:-}" = "1" ]; then
    return 0
  fi

  openpacker_stale=0
  if [ ! -f "$openpacker_target" ]; then
    openpacker_stale=1
  else
    # Unquoted glob on purpose: every workspace source tree that can affect the
    # CLI. -print -quit stops at the first newer file rather than walking all.
    # shellcheck disable=SC2086
    if [ -n "$(find "$openpacker_root/apps/opm/src" \
      $openpacker_root/packages/*/src \
      -type f -newer "$openpacker_target" -print -quit 2>/dev/null)" ]; then
      openpacker_stale=1
    fi
  fi

  if [ "$openpacker_stale" = "1" ]; then
    printf 'opm: sources changed since the last build, rebuilding...\n' >&2
    if ! (cd "$openpacker_root" &&
      npx turbo run build --filter=@openpacker/opm... >/dev/null 2>&1); then
      printf 'opm: build failed, refusing to run a stale binary.\n' >&2
      printf 'opm: run `npm run build` in %s to see the error.\n' \
        "$openpacker_root" >&2
      return 1
    fi
  fi

  return 0
}
