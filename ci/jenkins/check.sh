#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../unity-cursor-toolkit"

# The administrator supplies the runtime. Require the native dependency age gate.
node -e "const v=require('child_process').execFileSync('npm',['--version'],{encoding:'utf8'}).trim().split('.').map(Number); if(v[0]<11 || (v[0]===11 && (v[1]<14 || (v[1]===14 && v[2]<1)))) throw new Error('npm 11.14.1 or newer is required')"
test "$(npm config get min-release-age)" = '7'
test -f package-lock.json

npm ci
npx --yes github-actionlint@1.7.12 ../.github/workflows/ci.yml ../.github/workflows/release.yml \
  ../.github/workflows/jenkins.yml ../.github/workflows/jenkins-submit.yml \
  ../.github/workflows/jenkins-check.yml
npm run validate
npm run sync:package -- --check
bash ../ci/jenkins/vendor.sh

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
