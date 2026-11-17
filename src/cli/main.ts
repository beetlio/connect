#!/usr/bin/env node

// Check the runtime before loading the commands: on older Node.js releases their imports
// fail with a missing-export error that does not name the cause.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

// Keep aligned with "engines" in package.json.
if (major < 24 || (major === 24 && minor < 2)) {
  console.error(
    `beetl-connect requires Node.js 24.2 or later; this is Node.js ${process.versions.node}.`,
  );
  process.exit(1);
}

const { main } = await import("./commands.ts");

await main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
