#!/usr/bin/env bash
set -euo pipefail

echo "=== Pions Quick Health Check ==="
echo "Node: $(node --version)"
echo "npm: $(npm --version)"
echo "TypeScript: $(npx tsc --version)"

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

echo ""
echo "Checking build artifacts..."
if [ -f dist/src/index.js ]; then
  echo "✓ dist/src/index.js exists"
else
  echo "✗ dist/src/index.js MISSING — run 'npm run build'"
fi

if [ -f dist/src/worker-extension.js ]; then
  echo "✓ dist/src/worker-extension.js exists"
else
  echo "✗ dist/src/worker-extension.js MISSING — run 'npm run build'"
fi

echo ""
echo "=== Health check complete ==="
