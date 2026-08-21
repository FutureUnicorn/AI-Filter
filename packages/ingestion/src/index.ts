import type { BoundaryContract } from "@signal-audit/contracts";
import type { DomainPort } from "@signal-audit/domain";

/** File and parser adapters will terminate at this boundary. */
export interface IngestionAdapterBoundary {
  readonly contract: BoundaryContract;
  readonly domain: DomainPort;
}
