#!/usr/bin/env bash
set -euo pipefail

evidence=$1
shift

# The workflow supplies presence flags here. The actual credential values
# are scoped to the later step that needs them.
missing=()
for setting in "$@"; do
  if [[ "${!setting:-}" != true ]]; then
    missing+=("$setting")
  fi
done

if (( ${#missing[@]} == 0 )); then
  exit 0
fi

mkdir -p "$(dirname "$evidence")"
jq -n --args '{schema: "finnor.live-ci-configuration.v1", status: "BLOCKED", missing: $ARGS.positional}' \
  -- "${missing[@]}" > "$evidence"
printf '::error title=Missing live CI configuration::%s\n' "${missing[*]}"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '### Live check blocked by missing configuration\n\n'
    printf -- '- `%s`\n' "${missing[@]}"
  } >> "$GITHUB_STEP_SUMMARY"
fi
exit 1
