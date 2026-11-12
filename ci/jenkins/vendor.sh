#!/usr/bin/env bash
# Preserve the vendor workflow's Node version and artifact provenance checks.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../unity-cursor-toolkit"
test "$(npm config get min-release-age)" = '7'
npx --yes --package=node@26.4.0 -- npm run validate

vendor='../Packages/com.rankupgames.unity-cursor-toolkit/Editor/ThirdParty/Unity-Unterm'
source_commit="$(node -p "require('$vendor/VENDOR.json').sourceCommit")"
source_ref="$(node -p "require('$vendor/VENDOR.json').sourceRef")"
attestation_directory=$(mktemp -d)
trap 'rm -rf -- "$attestation_directory"' EXIT
# Verification uses public bundles. PR execution receives no GitHub credential.
unset GH_TOKEN GH_SOURCE_TOKEN GITHUB_TOKEN JENKINS_AUTH
export GH_CONFIG_DIR="$attestation_directory/gh" GH_HOST=github.com
mkdir "$GH_CONFIG_DIR"
for artifact in 'Plugins/macOS/unterm.dylib' 'Plugins/macOS/unterm-debugger' \
  'Plugins/Windows/x86_64/unterm.dll' 'Plugins/Windows/x86_64/unterm-debugger.exe' 'Third Party Notices.md'; do
  python3 - "$vendor/$artifact" "$attestation_directory/bundles.jsonl" <<'BUNDLES'
import hashlib
import json
import re
from pathlib import Path
import sys
from urllib.request import Request, urlopen

artifact, output = map(Path, sys.argv[1:])
digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
endpoint = 'https://api.github.com/repos/rankupgames/Unity-Unterm/attestations/sha256:' + digest + '?per_page=100'
request = Request(endpoint, headers={'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Unity-Toolkit-Vendor-Verification'})
with urlopen(request, timeout=40) as response:
    payload = response.read(2 * 1024 * 1024 + 1)
    assert len(payload) <= 2 * 1024 * 1024, 'vendor_attestations_oversized'
    links = ','.join(response.headers.get_all('Link', []))
    relations = {relation for quoted, bare in re.findall(r'\brel=(?:"([^"]+)"|([^;,\s]+))', links)
                 for relation in (quoted or bare).split()}
    assert 'next' not in relations, 'vendor_attestations_incomplete'
value = json.loads(payload)
assert isinstance(value, dict) and isinstance(value.get('attestations'), list), 'vendor_attestations_invalid'
attestations = value['attestations']
assert attestations and len(attestations) <= 100, 'vendor_attestations_missing'
assert all(isinstance(item, dict) and isinstance(item.get('bundle'), dict) for item in attestations), 'vendor_bundle_missing'
output.write_text(''.join(json.dumps(item['bundle']) + '\n' for item in attestations))
BUNDLES
  gh attestation verify "$vendor/$artifact" --bundle "$attestation_directory/bundles.jsonl" \
    --repo rankupgames/Unity-Unterm \
    --signer-workflow rankupgames/Unity-Unterm/.github/workflows/split-upm.yml \
    --source-digest "$source_commit" --source-ref "$source_ref" --deny-self-hosted-runners
done
