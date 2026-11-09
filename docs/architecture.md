# Architecture and extraction plan

Health Records is a single-owner record system. The browser and MCP tools use the same JSON files on WebDAV: meals, actual workouts, weights, goals, and profile. Existing validated models, summaries, replay protection, conditional writes, and user-facing loading/error/recovery states are retained.

## Boundaries

- React / TypeScript browser application: records, review, goals, profile, manual meals, photo recognition, and reviewed text narration.
- Shared TypeScript storage and domain layer: strong ETags, If-Match / If-None-Match, read-back verification, idempotent mutations, explicit uncertain results.
- MCP: local stdio and authenticated OAuth HTTP. Tools access the same owner WebDAV configuration. No other personal-workbench features are included.
- External WebDAV is the production storage contract. A loopback-only local development adapter provides persistent synthetic-demo storage with atomic replacement and conditional writes; it is not a general-purpose production DAV server.
- Optional OpenAI-compatible recognition uses a server-side runtime key. The browser never receives that key. Recognition proposes editable drafts; saving is explicit.
- Data files, credentials, private host configuration and source repository history are not distributed. Nutrition datasets require explicit redistribution permission; synthetic test food is never presented as real nutrition advice.

## Implementation and acceptance

1. Extract the existing health dependency closure and relevant tests into a fresh repository.
2. Remove unrelated navigation, tracking, private endpoint defaults and owner-specific integration code. Keep the health interface and workflow.
3. Add standalone connection settings, local development storage and configurable recognition proxy.
4. Retain and test stdio and OAuth HTTP MCP against the same storage.
5. Run domain/unit tests, build, synthetic integration tests, concurrent/replayed mutation tests, persistence and access-boundary tests.
6. Exercise the browser with synthetic data, including manual/photo/text review, workouts, weight, goals, errors and retry. Record what was tested and what still needs real-provider validation.
7. Audit the public file set for data, private URLs, credentials and third-party licensing before publication.
