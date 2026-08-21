# Repository boundaries

## Purpose

AF-10 establishes a pnpm/TypeScript workspace in which the domain is the stable center and executable applications are composition roots. The layout makes future ownership visible, while automated checks make dependency direction enforceable.

This document describes structure only. It does not authorize work that belongs to later environment, CI, contract, authentication, database, ingestion, or AI-provider tickets. All code must also comply with [`../PRODUCT_BOUNDARY.md`](../PRODUCT_BOUNDARY.md).

## Repository areas

| Area | Responsibility |
|---|---|
| `apps/web` | Next.js delivery and composition layer |
| `apps/worker` | Background-process composition layer |
| `packages/domain` | Framework-neutral domain abstractions and pure logic |
| `packages/contracts` | Explicit, versionable boundary contracts |
| `packages/db` | Persistence adapters and future migrations/repositories |
| `packages/ai` | AI-provider adapters and provider-to-domain mapping |
| `packages/ingestion` | Candidate-input and parser adapters |
| `packages/security` | Authentication and authorization infrastructure |
| `tests/architecture` | Executable dependency and workspace checks |
| `tests/integration` | Tests spanning more than one workspace |
| `tests/fixtures` | Synthetic, non-sensitive test data only |
| `evals` | Model-quality cases and datasets, separate from deterministic tests |

## Dependency direction

```text
apps/web        apps/worker
    |               |
    +-------+-------+
            |
     adapter packages
  db / ai / ingestion / security
            |
        contracts
            |
          domain
```

The diagram shows permitted inward direction, not a requirement for every possible edge. Packages should declare only dependencies they actually use.

| Source | Allowed internal dependencies |
|---|---|
| `domain` | None |
| `contracts` | `domain` |
| `db` | `domain` |
| `ai` | `domain`, `contracts` |
| `ingestion` | `domain`, `contracts` |
| `security` | `domain`, `contracts` |
| `web` | Public package APIs needed to compose the web runtime |
| `worker` | Public package APIs needed to compose the worker runtime |

Applications must not import each other's internals. Production code must not import `tests` or `evals`.

## Domain-owned abstractions

When the domain needs persistence, AI, ingestion, or security behavior, the domain owns the abstraction or port. The outer package imports and implements that abstraction.

Allowed:

```ts
// packages/db
import type { CandidateRepository } from "@signal-audit/domain";
```

Forbidden:

```ts
// packages/domain
import { PostgresCandidateRepository } from "@signal-audit/db";
```

The domain must not import framework or vendor APIs such as Next.js, React, database/ORM clients, AI SDKs, cloud SDKs, parser libraries, authentication vendors, or Node-specific infrastructure APIs.

## Public package boundaries

Cross-workspace imports must use the target package's public name:

```ts
import type { DomainPort } from "@signal-audit/domain";
```

Relative traversal into another workspace is forbidden:

```ts
import type { DomainPort } from "../../../packages/domain/src/index";
```

Each workspace must be private, uniquely named, extend `tsconfig.base.json`, expose intentional entry points, and declare every internal dependency with `workspace:*`.

## Automated enforcement

Run:

```bash
pnpm check:architecture
```

The check combines dependency-cruiser with `tests/architecture/check-workspace-boundaries.mjs`. Together they reject:

- domain-to-adapter/framework dependencies;
- package-to-application dependencies;
- application-to-application dependencies;
- undeclared internal package imports;
- cross-workspace relative source traversal;
- production imports from tests or evals;
- workspace and TypeScript import cycles.

Architecture changes are intentional design changes. If a new permitted edge is genuinely required, update the package manifest, executable checker, dependency-cruiser configuration, this document, and related tests in the same reviewed change.

## Adding a workspace package

1. Decide whether the package is domain, contract, adapter, or application code.
2. Place it under `packages/` or `apps/`; do not introduce a competing root layout.
3. Give it a unique private `@signal-audit/*` name and public export surface.
4. Extend `tsconfig.base.json` without weakening strictness.
5. Declare the smallest possible `workspace:*` dependency set.
6. Add its allowed inward edges to the architecture checker.
7. Add structure and negative tests proving forbidden outward edges fail.
8. Update the repository map and run `pnpm check`.

## Test and evaluation data

Normal tests must be deterministic and credential-free. Evals may later measure model behavior, cost, and prompt-injection resistance, but they remain separate from unit and integration tests. Neither area may contain real candidate PII, employer exports, production credentials, or unapproved sensitive data.
