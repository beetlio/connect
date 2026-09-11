import type { SyncHost } from "@beetlio/connect/host";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function fixtureDirectory(t: TestContext, name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${name}-`));

  t.after(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

export async function integrationPackage(
  directory: string,
  files: readonly string[] = ["integration.ts"],
): Promise<void> {
  const definition = {
    name: "fixture-beetl-integration",
    version: "0.0.0",
    private: true,
    type: "module",
    files,
  };

  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify(definition)),
    writeFile(
      join(directory, "package-lock.json"),
      JSON.stringify({
        name: definition.name,
        version: definition.version,
        lockfileVersion: 3,
        packages: { "": { name: definition.name, version: definition.version } },
      }),
    ),
  ]);
}

export function syncHost(overrides: Partial<SyncHost> = {}): SyncHost {
  return {
    async request() {
      throw new Error("Unexpected provider request");
    },
    async commit() {
      return "continue" as const;
    },
    async log() {},
    ...overrides,
  };
}
