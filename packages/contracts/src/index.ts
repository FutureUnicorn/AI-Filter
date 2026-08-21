import type { DomainPort } from "@signal-audit/domain";

/** Placeholder boundary shape; AF-13 owns real versioned runtime contracts. */
export interface BoundaryContract {
  readonly domain: DomainPort;
  readonly version: string;
}
