#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../unity-cursor-toolkit"

# Match the existing small-web profile. Do not install or replace worker tools.
test "$(node --version)" = 'v24.21.0'
test "$(npm --version)" = '11.19.0'
test "$(npm config get min-release-age)" = '7'
test -f package-lock.json

npm ci
npm run validate
npm run sync:package -- --check

# Keep the authored version. This lane neither stamps nor publishes releases.
node <<'NODE'
const assert = require('node:assert/strict');
const upm = require('../Packages/com.rankupgames.unity-cursor-toolkit/package.json');
for (const field of ['name', 'version', 'unity']) {
	assert.equal(typeof upm[field], 'string', `UPM package ${field} must be a string`);
	assert.ok(upm[field].trim(), `UPM package ${field} must not be empty`);
}
NODE

mkdir -p dist/jenkins
./node_modules/.bin/vsce package --no-dependencies --out dist/jenkins/unity-cursor-toolkit.vsix
test -s dist/jenkins/unity-cursor-toolkit.vsix
