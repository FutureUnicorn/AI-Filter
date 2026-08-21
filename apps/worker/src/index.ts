import { pathToFileURL } from "node:url";

import { DOMAIN_LAYER_NAME } from "@signal-audit/domain";

export function startWorker(): string {
  const message = `Signal Audit worker ready; dependency center=${DOMAIN_LAYER_NAME}`;
  console.log(message);
  return message;
}

const entryPath = process.argv[1];

if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  startWorker();
}
