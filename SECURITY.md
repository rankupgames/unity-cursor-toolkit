# Security Policy

## Reporting Vulnerabilities

**Preferred:** Open a [GitHub Security Advisory](https://github.com/rankupgames/unity-cursor-toolkit/security/advisories/new) for this repository.

**Alternative:** Email security@rankupgames.com with details.

Do not open public issues for security vulnerabilities.

## Response

- **Acknowledgment:** Within 48 hours
- **Resolution:** Target 7 days for critical issues; we will update you on progress

## Security Checks

Before release, run the extension validation suite from the extension package:

```bash
cd unity-cursor-toolkit
npm run validate
```

This runs compile, strict unused-code checks, runtime tests, production dependency audit, and full dependency audit.

Current hardening expectations:

- Webviews should use nonce-based Content Security Policy entries for scripts and styles.
- Workspace/user-provided filesystem paths must be normalized and checked before reads or writes.
- Unity/MCP/webview payloads should be treated as untrusted and validated before use.
- VSIX packages should not include tests, backups, lockfiles, source maps, or generated bundles.
