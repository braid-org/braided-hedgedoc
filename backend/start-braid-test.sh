#!/bin/bash
#
# Start HedgeDoc with a fresh DB and create a test user, API token, and note.
# Prints a URL to the braid test editor with side-by-side collaborative editing.
#
# Usage:
#   cd backend
#   yarn build       # or: cd .. && yarn workspace @hedgedoc/commons build && yarn workspace @hedgedoc/database build && cd backend && ../node_modules/.bin/nest build
#   ./start-braid-test.sh
#
# For the full HedgeDoc UI (optional):
#   In another terminal: cd frontend && yarn start:dev
#   In another terminal: cd dev-reverse-proxy && caddy run --config Caddyfile
#   Then open http://localhost:8080/s/test-doc

set -e
cd "$(dirname "$0")"

echo "Cleaning up..."
rm -f hedgedoc-test.sqlite
rm -rf braid-text-db
pkill -f "node dist/src/main.js" 2>/dev/null || true
sleep 1

echo "Starting HedgeDoc backend..."
node dist/src/main.js &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null" EXIT
sleep 5

echo "Creating test user and API token..."
COOKIES=$(mktemp)

CSRF=$(curl -s -c "$COOKIES" http://localhost:3000/api/private/csrf/token \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s -c "$COOKIES" -b "$COOKIES" \
  -X POST http://localhost:3000/api/private/auth/local \
  -H "csrf-token: $CSRF" -H "Content-Type: application/json" \
  -d '{"username":"testuser","displayName":"Test","password":"TestPassword123!"}' > /dev/null

CSRF=$(curl -s -b "$COOKIES" -c "$COOKIES" http://localhost:3000/api/private/csrf/token \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

TOKEN=$(curl -s -b "$COOKIES" -c "$COOKIES" \
  -X POST http://localhost:3000/api/private/tokens \
  -H "csrf-token: $CSRF" -H "Content-Type: application/json" \
  -d '{"label":"braid-test","validUntil":"2027-01-01T00:00:00.000Z"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")

rm -f "$COOKIES"

echo "Creating test note..."
curl -s -X POST http://localhost:3000/api/v2/notes/test-doc \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/markdown" \
  -d "# Welcome to Braid" > /dev/null

echo ""
echo "====================================================="
echo "Braid test editor (side-by-side sync):"
echo ""
echo "  http://localhost:3000/public/braid-test-editor.html?alias=test-doc&token=${TOKEN}"
echo ""
echo "curl test:"
echo ""
echo "  curl -H 'Authorization: Bearer ${TOKEN}' http://localhost:3000/api/v2/notes/test-doc/content"
echo ""
echo "====================================================="
echo ""
echo "Press Ctrl+C to stop."

wait $SERVER_PID
