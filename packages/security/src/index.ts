import type { BoundaryContract } from "@signal-audit/contracts";
import type { DomainPort } from "@signal-audit/domain";

/** Auth and authorization vendors will remain outside the domain here. */
export interface SecurityAdapterBoundary {
  readonly contract: BoundaryContract;
  readonly domain: DomainPort;
}
