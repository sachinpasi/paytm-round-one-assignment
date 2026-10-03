#!/usr/bin/env sh
# ./burst.sh https://your-service.onrender.com   (needs Node 18+; extra flags are passed through)
# Defaults to 127.0.0.1: on macOS, localhost also tries IPv6 and drops connections under heavy load.
cd "$(dirname "$0")" || exit 1
url="${1:-${BASE_URL:-http://127.0.0.1:3000}}"
[ $# -gt 0 ] && shift
exec node scripts/burst.mjs "$url" "$@"
