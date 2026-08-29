#!/usr/bin/env sh
set -eu

release_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
client=none
configure=false
replace=false
skip_install=false
database_path=
config_path=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --client) client=$2; shift 2 ;;
    --configure) configure=true; shift ;;
    --replace) replace=true; shift ;;
    --skip-install) skip_install=true; shift ;;
    --db) database_path=$2; shift 2 ;;
    --config) config_path=$2; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$client" in
  none|claude-code|codex|opencode) ;;
  *) echo "--client must be none, claude-code, codex, or opencode" >&2; exit 2 ;;
esac

cd "$release_root"
node_major=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22 or newer is required." >&2
  exit 2
fi

if [ "$skip_install" = false ]; then npm ci; fi
npm run typecheck
npm test
npm run build

if [ "$client" = none ]; then
  echo "Setup verified. No client configuration was changed."
  exit 0
fi

set -- scripts/render-client-config.mjs --client "$client"
if [ -n "$database_path" ]; then set -- "$@" --db "$database_path"; fi
if [ "$configure" = true ]; then set -- "$@" --write; fi
if [ "$replace" = true ]; then set -- "$@" --replace; fi
if [ -n "$config_path" ]; then set -- "$@" --config "$config_path"; fi
exec node "$@"
