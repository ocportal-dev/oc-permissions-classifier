#!/bin/zsh
# Exports TYPESAFE_API_KEY from ~/.zshrc's TYPESAFE_AI_API_KEY, then runs the given command.
set -e
if [[ -z "$TYPESAFE_API_KEY" ]]; then
  line="$(grep -E '^export TYPESAFE_AI_API_KEY=' "$HOME/.zshrc" | head -1)"
  [[ -z "$line" ]] && { echo "TYPESAFE_AI_API_KEY not found in ~/.zshrc" >&2; exit 1; }
  value="${line#export TYPESAFE_AI_API_KEY=}"
  export TYPESAFE_API_KEY="${value//[\"\']/}"
fi
exec "$@"
