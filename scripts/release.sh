#!/bin/bash
# Usage: ./scripts/release.sh 1.0.1

VERSION=$1

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 1.0.1"
  exit 1
fi

echo "Releasing Axon v$VERSION..."

# Update version in package.json
npm version $VERSION --no-git-tag-version

# Commit
git add package.json
git commit -m "chore: release v$VERSION"

# Tag — this triggers GitHub Actions
git tag "v$VERSION"

# Push
git push origin main
git push origin "v$VERSION"

echo "Release v$VERSION pushed — GitHub Actions will build the DMG"
echo "Check: https://github.com/IsaacStallan/Axon-desktop/actions"
