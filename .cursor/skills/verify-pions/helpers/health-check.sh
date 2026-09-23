#!/usr/bin/env bash
set -euo pipefail

npm_version() {
  if command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
    npm --version
    return 0
  fi
  if command -v mise >/dev/null 2>&1 && mise exec -- npm --version >/dev/null 2>&1; then
    echo "$(mise exec -- npm --version) (via mise exec)"
    return 0
  fi
  return 1
}

echo "=== Pions Quick Health Check ==="
echo "Node: $(node --version)"
if npm_ver=$(npm_version); then
  echo "npm: ${npm_ver}"
else
  echo "npm: NOT AVAILABLE (broken PATH? put mise node bin ahead of ~/.local/bin, or use: mise exec -- npm …)"
fi
echo "TypeScript: $(npx tsc --version 2>/dev/null || echo 'NOT AVAILABLE')"

if command -v herdr &> /dev/null; then
  echo "Herdr: $(herdr --version)"
else
  echo "Herdr: NOT AVAILABLE (live delegation will fail)"
fi

if command -v pi &> /dev/null; then
  echo "Pi: $(pi --version)"
else
  echo "Pi: NOT AVAILABLE (live delegation will fail)"
fi

if [ -s "${HOME}/.pi/agent/auth.json" ]; then
  echo "Pi auth: auth.json present"
else
  echo "Pi auth: NOT CONFIGURED (run pi /login or set provider keys — live delegation will fail)"
fi

echo ""
echo "Checking build artifacts..."
if [ -f dist/src/worker-extension.js ]; then
  echo "✓ dist/src/worker-extension.js exists"
else
  echo "✗ dist/src/worker-extension.js MISSING — run 'npm run build'"
fi

echo ""
echo "=== Health check complete ==="
