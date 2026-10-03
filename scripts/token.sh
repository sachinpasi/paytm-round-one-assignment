#!/usr/bin/env sh
# Prints a token, e.g.  curl localhost:3000/me -H "Authorization: Bearer $(./scripts/token.sh alice)"
# usage: ./scripts/token.sh <user_id> [admin_key]
BASE="${BASE_URL:-http://localhost:3000}"

if [ -n "$2" ]; then
  BODY="{\"user_id\":\"$1\",\"admin_key\":\"$2\"}"
else
  BODY="{\"user_id\":\"$1\"}"
fi

curl -s -X POST "$BASE/auth/token" -H 'content-type: application/json' -d "$BODY" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token'
