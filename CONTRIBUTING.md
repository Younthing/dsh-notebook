# Contributing

Thank you for contributing to dsh-notebook. Open an issue before a large behavior or package-boundary change so the design can be agreed before implementation.

Use Node.js `^22.19.0 || >=24.0.0` and the pnpm version declared in `package.json`. Install from the lockfile and run the focused tests that own the changed behavior. Before submitting a release-facing change, run the same aggregate quality gate as CI:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Tests must not require an API key by default. Keep real Python/Jupyter checks opt-in, and keep generated artifacts, credentials, local environments, and notebooks containing private data out of commits. Every package remains ESM, strictly typed, and independently packable.

By submitting a contribution, you agree that it is licensed under the repository's MIT License.
