# Repository-owned Jenkins CI

`.github/workflows/jenkins.yml` is the application CI configuration. Its literal
`env.JENKINS_CI` JSON declares the `check` lane, existing required status
`jenkins/unity-cursor-toolkit/check`, Linux `small-web` profile, timeout,
command and artifact path. The local `jenkins-submit.yml` is the generic
submission transport. Actions sends metadata without checking out PR source.

The platform reads the workflow and source at the exact committed revision.
Same-repository PR submissions include their number and exact head SHA.
The lane uses `local-first`: one admitted local check, with overflow only after
a clean busy result. A started failure does not retry on another route.
Fork execution is not admitted by this lane.

`bash ci/jenkins/check.sh` uses the existing extension checks and package entry
points. It requires age-gated npm, installs the committed lockfile, lints
workflows, runs full validation, checks package sync and UPM metadata, verifies
vendor provenance, and packages the authored version without publishing.
The artifact contract is `unity-cursor-toolkit/dist/jenkins/*.vsix`.
`vendor.sh` retains the existing Node 26 validation and five artifact attestations.
Git preserves exact vendor and notice bytes on Windows so reviewed hashes remain valid.

Private controller policy owns runtime pins, credentials, worker bindings and
capacity. The workflow contains only secret and variable references.
No project registration, project Jenkinsfile or `.rug-service/ci.json` is needed
after adoption. Release and marketplace approvals remain separate.

## Local checks

Run from `unity-cursor-toolkit/`, without Jenkins admission:

```sh
npm ci
npm run validate
npm run sync:package -- --check
npx --no-install vsce package --no-dependencies --out <artifact-path>.vsix
```

From the repository root, lint the workflows:

```sh
npx --yes github-actionlint@1.7.12 .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/jenkins.yml .github/workflows/jenkins-submit.yml
```

## Adoption boundary

The legacy loader remains for bootstrap. `jenkins-check.yml` is manual-only,
so ordinary events submit through `jenkins.yml` once.
After ordinary default-branch and PR runs prove the exact source, trusted
pending-to-terminal status, native build URL, route, artifact and owned cleanup,
remove the legacy `Jenkinsfile`, `ci/jenkins/request.js`, its tests and old
`jenkins-check.yml` trigger. Preserve release gates and active attempts.
Do not dispatch the legacy workflow during ordinary adoption proof.

The platform workflow route currently rejects Windows. Linux validation and VSIX
packaging do not qualify Unity Editor, Windows or macOS package execution.
Keep existing native Unity requirements until matching workers are qualified.
Use the existing compatibility and package build commands. Do not add another
Unity harness or remove Unity assets, caches or proof artifacts during migration.
