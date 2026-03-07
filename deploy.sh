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
pm2 restart claude-chat --update-env

echo "==> Done."
