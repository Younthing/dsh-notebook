# Security Policy

## Supported versions

Until the first stable release, only the latest published pre-release receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for `Younthing/dsh-notebook`. Include the affected version, reproduction conditions, impact, and any proposed mitigation. If private reporting is unavailable, open an issue without vulnerability details and ask the maintainer for a private contact channel.

Notebook execution runs arbitrary user or model-authored code. A report about expected code execution is actionable only when it escapes the configured Harness sandbox or gains permissions beyond the selected profile, session, or workspace policy.
