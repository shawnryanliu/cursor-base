#!/bin/bash
set -e

echo "==> Pulling latest code..."
git pull

if [ -f "backend/package.json" ]; then
  echo "==> Installing backend dependencies..."
  cd backend
  npm install --production
  cd ..
fi

echo "==> Restarting backend..."
fuser -k 4000/tcp 2>/dev/null || true
sleep 1
pm2 restart claude-chat --update-env

echo "==> Done."
