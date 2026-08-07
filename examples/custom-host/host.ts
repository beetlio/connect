import {
  runSync,
  type EmittedBatch,
  type LogEntry,
  type ProviderRequest,
  type ProviderResponse,
  type SyncHost,
  verifyConnection,
} from "@beetlio/connect/host";

import integration from "../wikidata/integration.ts";

class ConsoleHost implements SyncHost {
  #snapshot: EmittedBatch["records"][number][] | undefined;

  async request(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderResponse> {
    const origin = new URL("https://www.wikidata.org");
    const url = new URL(request.path, origin);
    if (url.origin !== origin.origin) {
      throw new Error("Provider request escaped the configured origin");
    }

    const response = await fetch(url, {
      method: request.method,
      headers: request.headers.map(([name, value]): [string, string] => [name, value]),
      redirect: "manual",
      ...(request.body === undefined ? {} : { body: Uint8Array.from(request.body).buffer }),
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      status: response.status,
      headers: [...response.headers.entries()],
      body: new Uint8Array(await response.arrayBuffer()),
    };
  }

  async emit(batch: EmittedBatch): Promise<void> {
    if (this.#snapshot !== undefined) {
      this.#snapshot.push(...batch.records);
      return;
    }
    for (const record of batch.records) console.log(JSON.stringify(record));
  }

  async log(entry: LogEntry): Promise<void> {
    console.error(`[${entry.level}] ${entry.message}`, entry.fields);
  }

  async beginSnapshot(): Promise<void> {
    this.#snapshot = [];
  }

  async commitSnapshot(): Promise<void> {
    for (const record of this.#snapshot ?? []) console.log(JSON.stringify(record));
    this.#snapshot = undefined;
  }

  async abortSnapshot(): Promise<void> {
    this.#snapshot = undefined;
  }
}

const host = new ConsoleHost();
const connectionConfig = {
  userAgent: "connect-host-example/1.0 (https://github.com/beetlio/connect)",
};

await verifyConnection(integration, { connectionConfig }, host);
const result = await runSync(
  integration,
  "entities",
  {
    connectionConfig,
    syncConfig: { search: "open source", maxResults: 5 },
  },
  host,
);
console.error(result);
