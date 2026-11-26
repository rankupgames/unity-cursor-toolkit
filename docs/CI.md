# Build and release

GitHub Actions validates and packages the extension on pull requests and pushes
to main and Version-* branches. The weekly build runs on Friday at 11:00 UTC.
The release-approval environment controls publication to Open VSX and VS Code
Marketplace. A VS Code Marketplace failure does not block Open VSX.
Marketplace uses Trusted Publishing policies for ci.yml and release.yml in the
release-approval environment.

The tag release workflow builds both VSIX files and attaches them to the GitHub
release. The release notes link to the UPM package in the tagged source.

The Unity-Unterm vendor workflow verifies source provenance on pull requests.
Dispatch it with run_native enabled for the licensed macOS and Windows checks.

## Local checks

Run from unity-cursor-toolkit/:

    npm ci
    npm run validate
    npm run sync:package -- --check
    npx --no-install vsce package --no-dependencies --out <artifact-path>.vsix

Run from the repository root:

    npx --yes github-actionlint@1.7.12 .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/unity-unterm-vendor.yml

See [local Unity compatibility checks](UNITY_COMPATIBILITY.md) for exact Editor verification.
