# Jenkins checks

The root `Jenkinsfile` uses the shared `homelabPipeline` library. Its registered
`check` lane uses the existing Linux `small-web` profile and a 30-minute timeout.
The administrator pins the library, source revision and read-only SCM credential.
The job must load the root Jenkinsfile at the same `SOURCE_SHA` it checks out.

`bash ci/jenkins/check.sh` runs only inside Jenkins. It checks the profile's Node
24.21.0 and npm 11.19.0 tools, the seven-day age gate, and the committed lockfile.
It then runs `npm ci`, full `npm run validate`, package-sync validation, UPM
metadata validation and VSIX packaging. The VSIX stays in the isolated worker
workspace at `unity-cursor-toolkit/dist/jenkins/unity-cursor-toolkit.vsix`.
The current shared local lane does not archive that file to the Jenkins run.
This lane creates no containers and publishes no packages or GitHub statuses.

## Submit reviewed source

Generate a typed request from the repo root:

```sh
node ci/jenkins/request.js --branch <approved-branch> --source-sha <40-hex-commit> --lane check
```

This command only prints JSON. Send it through the existing approved admin
binding to `check-lanes.py dispatch SITE -`. Keep `SITE`, the canonical writer
state and all credentials on that admin host. Do not call Jenkins build APIs
from this repository. The shared dispatcher verifies registration and the current
branch head, handles admission, and uses the external reporter for GitHub status.

The shared registry entry needs this repository, the approved branch, existing
SCM/library credential references, an existing protected parent folder, and one
lane: `id=check`, `profile=small-web`, `runTimeoutSeconds=1800`,
`context=jenkins/unity-cursor-toolkit/check`, `ownedContainers=[]`.
Select the child-folder name during registration. Keep its job disabled outside
the administrative dispatch lifecycle.

Resolve the accepted immutable shared revision, approved job placement and admin
binding through the infrastructure owner. Keep private runbooks, host addresses,
job paths, credential identities and reporter state outside this public repo.
Register and dispatch only after the source and registry changes are approved
and published. A passing result needs the exact tested SHA and native Jenkins
build URL. Retain failures, skipped checks and cleanup limits.

## Cutover boundaries

This first lane does not replace the required Actions checks. Preserve their
bindings until the Jenkins reporter is accepted and the protection change is
approved. Retire old build triggers as part of that authorized cutover, after
accounting for active and queued runs. Actions activation is separate.

The accepted dispatcher supports registered Linux branch heads. Automatic PR
dispatch and the Actions front door need a reviewed admin binding. This lane
does not select Instabox overflow. Reuse the shared portable or managed Actions
adapter after its project-specific tools, credentials and output contract are
approved. Do not add a second scheduler or an unmanaged worker.

Vendor attestation verification and its Node 26 toolchain remain separate gates.
Windows/macOS Unity runtime proofs require compatible workers. Linux validation
does not prove native Unity compatibility. Release approvals and marketplace
publication remain in their existing separate scope.
