# Health Records

Read README.md and docs/architecture.md before changes. Browser, CLI and MCP must share the same domain/storage functions. Preserve complete snapshots, stable mutation IDs, strong-ETag conditional writes, uncertain-write reporting and read-back verification.

Use isolated task branches/worktrees. Use synthetic records and local fixtures for tests. Never read or copy a user's real health data or credential files into tests, screenshots or public artifacts. Do not invoke paid providers, deploy or publish without authorization. Keep optional AI keys server-side and avoid private endpoint defaults.

Run npm test and npm run build. Changes to forms, loading, error, cancellation or retry require a browser regression using synthetic data. Document what was actually verified; a mock provider does not prove model accuracy. Stop owned temporary servers and browser tasks after acceptance.
