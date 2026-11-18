#!/usr/bin/env node

// Check the runtime before loading the commands: on older Node.js releases their imports
// fail with a missing-export error that does not name the cause.
import { createRequire } from "node:module";

const { engines } = createRequire(import.meta.url)("../../package.json") as {
  readonly engines: { readonly node: string };
};
const [requiredMajor = 0, requiredMinor = 0] = (/^>=(\d+)\.(\d+)$/.exec(engines.node) ?? [])
  .slice(1)
  .map(Number);
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

if (major < requiredMajor || (major === requiredMajor && minor < requiredMinor)) {
  console.error(
    `beetl-connect requires Node.js ${requiredMajor}.${requiredMinor} or later; this is Node.js ${process.versions.node}.`,
  );
  process.exit(1);
}

const { main } = await import("./commands.ts");

await main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
