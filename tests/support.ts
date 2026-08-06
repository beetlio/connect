import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { SyncHost } from "@beetlio/connect/host";

export async function fixtureDirectory(t: TestContext, name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${name}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function fixtureServer(t: TestContext, listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function syncHost(overrides: Partial<SyncHost> = {}): SyncHost {
  return {
    async request() {
      throw new Error("Unexpected provider request");
    },
    async emit() {},
    async log() {},
    ...overrides,
  };
}
