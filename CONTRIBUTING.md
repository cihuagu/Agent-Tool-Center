# Contributing

## Setup and tests

Install Node.js 22 or later and Git. From the project root, install dependencies using the committed lockfile and run the tests:

```sh
npm ci
npm test
```

Process and native integration tests run serially to avoid resource contention.

The official MCP SDK is a root runtime dependency pinned by the lockfile. Codex and a Windows compiler are required only for their respective runtime features, not for every test.

Full MCPHub integration is optional and requires a separately prepared, fixed-version external checkout, its dependencies, and build artifacts in the project cache. Report skipped tests and their reasons; historical local results are not a promise for every environment. Do not copy maintainer caches or private conversation data.

## Submitting changes

Keep changes focused and explain their purpose, impact, and actual verification results. Preserve strict runtime allowlists and identify the sources and licenses of added code and dependencies. Do not include real acceptance logs, credentials, or private session traces in pull requests.
