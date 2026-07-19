# Changelog

All notable changes to `@dahab-tech/altaer-sdk` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versioning follows [Semantic Versioning](https://semver.org/).

## [0.0.28] — 2026-07-20

Documentation polish. No code / contract change.

### Changed

- **Conventions section** — split the "Money is integer minor units" and "Rates are decimals" rules into distinct bullets so each has its own bold label. `opts` sub-fields (`signal`, `idempotencyKey`, `maxRetries`) broken into a nested list. Applied consistently on both the [hub.altaer.app/docs/api](https://hub.altaer.app/docs/api) page and the package README.
- **README's Webhook delivery rules** expanded from a paragraph to the same four-bullet list that already existed on the docs page — at-least-once semantics, retry policy, thrown-handler behaviour, and hung-handler behaviour each on its own line.

## [0.0.26] — 2026-07-20

Initial public release.

Typed TypeScript client for the [Altaer](https://altaer.app) delivery-dispatch API — create orders, stream live driver GPS, receive signed webhooks, reconcile balances. Full reference at [hub.altaer.app/docs/api](https://hub.altaer.app/docs/api).

[0.0.28]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.28
[0.0.26]: https://github.com/Dahab-Tech/altaer-sdk/releases/tag/v0.0.26
