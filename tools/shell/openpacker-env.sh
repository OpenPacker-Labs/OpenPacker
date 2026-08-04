# shellcheck shell=bash
#
# Put this repository's `opm` and `opmx` on PATH whenever the shell is inside
# it, and take them off again on the way out.
#
# Add one line to ~/.bashrc or ~/.zshrc:
#
#     source /path/to/openpacker/tools/shell/openpacker-env.sh
#
# The path is resolved when you source it, so moving the checkout means
# updating that line. `npm run dev:shell` prints it for this checkout.
#
# Nothing here is required to use opm — it is a convenience for working on
# OpenPacker itself. The launchers in tools/dev-bin also work when called
# directly.

# zsh's own "path of the file being sourced" expansion is not valid syntax in
# other shells, so it is reached through eval and only when zsh is running.
if [ -n "${ZSH_VERSION:-}" ]; then
  eval '_openpacker_self=${(%):-%x}'
elif [ -n "${BASH_SOURCE[0]:-}" ]; then
  _openpacker_self=${BASH_SOURCE[0]}
else
  _openpacker_self=$0
fi

OPENPACKER_ROOT=$(cd -- "$(dirname -- "$_openpacker_self")/../.." && pwd)
export OPENPACKER_ROOT
unset _openpacker_self

_openpacker_bin="$OPENPACKER_ROOT/tools/dev-bin"

# Rebuilt from scratch each time rather than appended to, so repeated prompts
# cannot stack duplicate entries and leaving the directory really removes it.
_openpacker_path_without_bin() {
  local result=''
  local entry
  local IFS=:
  for entry in $PATH; do
    [ "$entry" = "$_openpacker_bin" ] && continue
    if [ -z "$result" ]; then result=$entry; else result="$result:$entry"; fi
  done
  printf '%s' "$result"
}

_openpacker_sync_path() {
  local stripped
  stripped=$(_openpacker_path_without_bin)
  case "$PWD/" in
    "$OPENPACKER_ROOT"/*) PATH="$_openpacker_bin:$stripped" ;;
    *) PATH="$stripped" ;;
  esac
  export PATH
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook chpwd _openpacker_sync_path
elif [ -n "${BASH_VERSION:-}" ]; then
  case "${PROMPT_COMMAND:-}" in
    *_openpacker_sync_path*) ;;
    '') PROMPT_COMMAND='_openpacker_sync_path' ;;
    *) PROMPT_COMMAND="_openpacker_sync_path;${PROMPT_COMMAND}" ;;
  esac
fi

# Apply immediately, so sourcing this from inside the repo works without
# needing to cd out and back in first.
_openpacker_sync_path
