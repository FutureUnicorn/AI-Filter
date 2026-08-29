import type { BoundaryContract } from "@signal-audit/contracts";
import type { DomainPort } from "@signal-audit/domain";

/** AI provider adapters will map provider data into domain-owned abstractions. */
export interface AiAdapterBoundary {
  readonly contract: BoundaryContract;
  readonly domain: DomainPort;
}
