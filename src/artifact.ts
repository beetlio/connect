import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, setSourceMapsSupport } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build, formatMessages } from "esbuild";
import { create as createTar, extract as extractTar } from "tar";
import ts from "typescript";
import { z } from "zod";

import {
  createIntegrationManifest,
  type IntegrationDefinition,
  type IntegrationManifest,
} from "./index.ts";
import { validateIntegration } from "./host.ts";

const SdkEntry = fileURLToPath(new URL("./index.js", import.meta.url));
const SdkTypesEntry = fileURLToPath(new URL("./index.d.ts", import.meta.url));
const SdkDirectory = dirname(SdkEntry);
const NodeTypesDirectory = dirname(
  dirname(createRequire(import.meta.url).resolve("@types/node/package.json")),
);
const Encoder = new TextEncoder();
const Limits = {
  archive: 25 * 1024 * 1024,
  expanded: 50 * 1024 * 1024,
  bundle: 15 * 1024 * 1024,
  manifest: 1024 * 1024,
  icon: 512 * 1024,
} as const;
const NpmPackResultSchema = z
  .array(
    z.object({
      filename: z.string().min(1),
      size: z.number().nonnegative(),
      unpackedSize: z.number().nonnegative(),
      files: z.array(z.object({ path: z.string().min(1) })),
    }),
  )
  .length(1);
const PackageDefinitionSchema = z.object({
  files: z.array(z.string().min(1)).min(1).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  bundledDependencies: z.unknown().optional(),
  bundleDependencies: z.unknown().optional(),
  workspaces: z.unknown().optional(),
});
const PackageLockSchema = z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(z.string(), z.unknown()).refine((packages) => Object.hasOwn(packages, ""), {
    error: "root package is missing",
  }),
});
const DependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const RegistryDependencyPattern =
  /^(?:npm:(?:@[^/\\:@]+\/[^/\\:@]+|[^/\\:@]+)(?:@[^:/\\]+)?|[^:/\\]*)$/;
const ExecFile = promisify(execFile);
setSourceMapsSupport(true);

interface BuiltIntegration {
  readonly integration: IntegrationDefinition;
  readonly manifest: IntegrationManifest;
}

interface PackedIntegration {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly files: readonly string[];
}

export function loadIntegration(inputPath: string): Promise<BuiltIntegration> {
  return buildIntegration(inputPath);
}

export async function packIntegration(inputDirectory: string): Promise<PackedIntegration> {
  const directory = await realpath(resolve(inputDirectory));
  if (!(await stat(directory)).isDirectory()) {
    throw new Error("pack requires an integration package directory");
  }
  let packageSource: string;
  let lockfile: Uint8Array;
  try {
    const [definition, locked] = await Promise.all([
      readFile(join(directory, "package.json"), "utf8"),
      readFile(join(directory, "package-lock.json")),
    ]);
    packageSource = definition;
    lockfile = new Uint8Array(locked);
  } catch (error) {
    throw new Error("Integration packages require package.json and package-lock.json", {
      cause: error,
    });
  }
  assertSize("package-lock.json", lockfile, Limits.expanded);
  let packageDefinition: z.output<typeof PackageDefinitionSchema>;
  let lockedDefinition: z.output<typeof PackageDefinitionSchema>;
  try {
    packageDefinition = PackageDefinitionSchema.parse(JSON.parse(packageSource));
    const packageLock = PackageLockSchema.parse(JSON.parse(new TextDecoder().decode(lockfile)));
    lockedDefinition = PackageDefinitionSchema.parse(packageLock.packages[""]);
  } catch (error) {
    throw new Error("Integration package metadata is invalid", { cause: error });
  }
  if (packageDefinition.workspaces !== undefined) {
    throw new Error("Integration packages cannot declare npm workspaces");
  }
  if (packageDefinition.files === undefined) {
    throw new Error('Integration package.json requires an explicit "files" allowlist');
  }
  for (const path of packageDefinition.files) {
    if (
      path === "." ||
      path.startsWith(".") ||
      path.includes("\\") ||
      path.split("/").includes("..") ||
      /[*?\[\]{}!]/.test(path) ||
      isAbsolute(path)
    ) {
      throw new Error(`Integration package files entry ${JSON.stringify(path)} is too broad`);
    }
  }
  const declaredFiles = packageDefinition.files.map((path) => path.replace(/\/+$/, ""));
  if (
    packageDefinition.bundledDependencies !== undefined ||
    packageDefinition.bundleDependencies !== undefined
  ) {
    throw new Error("Integration packages cannot bundle node_modules");
  }
  for (const field of DependencyFields) {
    const dependencies = packageDefinition[field] ?? {};
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!RegistryDependencyPattern.test(specifier)) {
        throw new Error(
          `Integration dependency ${JSON.stringify(name)} must resolve from the npm registry`,
        );
      }
    }
    const locked = lockedDefinition[field] ?? {};
    if (
      Object.keys(dependencies).length !== Object.keys(locked).length ||
      Object.entries(dependencies).some(([name, specifier]) => locked[name] !== specifier)
    ) {
      throw new Error(`package-lock.json ${field} are out of sync with package.json`);
    }
  }

  const destination = await mkdtemp(join(tmpdir(), "beetl-connect-pack-"));
  try {
    let stdout: string;
    try {
      const npm =
        process.platform === "win32"
          ? [process.execPath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
          : ["npm"];
      const result = await ExecFile(
        npm[0]!,
        [
          ...npm.slice(1),
          "pack",
          "--json",
          "--ignore-scripts",
          "--cache",
          join(destination, "cache"),
          "--pack-destination",
          destination,
        ],
        { cwd: directory, encoding: "utf8", maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      );
      stdout = result.stdout;
    } catch (error) {
      throw new Error("Could not pack integration with npm", { cause: error });
    }
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch (error) {
      throw new Error("npm returned an invalid pack result", { cause: error });
    }
    const parsed = NpmPackResultSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Invalid npm pack result: ${z.prettifyError(parsed.error)}`);
    }
    const packed = parsed.data[0]!;
    if (packed.size > Limits.archive) {
      throw new Error("Integration package exceeds 25 MiB");
    }
    const files = new Set(packed.files.map(({ path }) => path));
    if (!files.has("integration.ts")) {
      throw new Error("npm package must include integration.ts");
    }
    const privateFile = [...files].find((path) => {
      const segments = path.split("/");
      return (
        segments.some(
          (segment) =>
            segment.startsWith(".env") || segment === ".beetl" || segment === "node_modules",
        ) || path.endsWith(".ndjson")
      );
    });
    if (privateFile !== undefined) {
      throw new Error(`Integration package contains private runtime file ${privateFile}`);
    }
    const undeclaredFile = [...files].find(
      (path) =>
        path !== "package.json" &&
        !/^(?:readme|licen[cs]e)(?:\..*)?$/i.test(path) &&
        !declaredFiles.some((declared) => path === declared || path.startsWith(`${declared}/`)),
    );
    if (undeclaredFile !== undefined) {
      throw new Error(`npm included ${undeclaredFile} outside the package files allowlist`);
    }
    if (packed.unpackedSize + lockfile.byteLength > Limits.expanded) {
      throw new Error("Integration package expands beyond 50 MiB");
    }
    if (basename(packed.filename) !== packed.filename) {
      throw new Error("npm returned an invalid package filename");
    }
    const archive = join(destination, packed.filename);
    const unpacked = join(destination, "unpacked");
    await mkdir(unpacked);
    await extractTar({ cwd: unpacked, file: archive, strict: true });
    await writeFile(join(unpacked, "package", "package-lock.json"), lockfile);
    await createTar(
      {
        cwd: unpacked,
        file: archive,
        gzip: true,
        mtime: new Date(0),
        portable: true,
        strict: true,
      },
      ["package"],
    );
    const bytes = new Uint8Array(await readFile(archive));
    assertSize("integration package", bytes, Limits.archive);
    return {
      bytes,
      filename: packed.filename,
      files: [...new Set([...files, "package-lock.json"])].sort(),
    };
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

async function buildIntegration(inputPath: string): Promise<BuiltIntegration> {
  const entryPath = await resolveIntegrationEntry(inputPath);
  const workingDirectory = dirname(entryPath);
  let output;
  try {
    output = await build({
      absWorkingDir: workingDirectory,
      entryPoints: [basename(entryPath)],
      outfile: "integration.mjs",
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24.2",
      mainFields: ["module", "main"],
      sourcemap: "inline",
      sourcesContent: false,
      metafile: true,
      write: false,
      logLevel: "silent",
      logOverride: { "unsupported-dynamic-import": "error" },
      plugins: [
        {
          name: "beetl-connect-imports",
          setup(builder) {
            builder.onResolve({ filter: /^@beetlio\/connect$/ }, () => ({ path: SdkEntry }));
          },
        },
      ],
    });
  } catch (error) {
    throw await integrationBuildError(error, entryPath);
  }

  const bundle = output.outputFiles.find((file) => file.path.endsWith("integration.mjs"))?.contents;
  if (!bundle) throw new Error("Bundler did not produce integration.mjs");
  assertSize("integration.mjs", bundle, Limits.bundle);
  await typeCheckIntegration(entryPath);
  const integration = await importBundle(bundle, inputPath);
  validateIntegration(integration);
  const manifest = createIntegrationManifest(integration);
  assertSize("manifest.json", Encoder.encode(JSON.stringify(manifest)), Limits.manifest);
  await validateIntegrationIcon(entryPath, integration.icon);

  for (const input of Object.keys(output.metafile.inputs)) {
    if (input.startsWith("<")) continue;
    const path = resolve(workingDirectory, input);
    if (pathWithin(SdkDirectory, path) || path.replaceAll("\\", "/").includes("/node_modules/")) {
      continue;
    }
    if (!pathWithin(workingDirectory, path)) {
      throw new Error(`Integration source imports outside its package directory: ${path}`);
    }
  }
  return { integration, manifest };
}

async function importBundle(bundle: Uint8Array, source: string): Promise<IntegrationDefinition> {
  const directory = await mkdtemp(join(tmpdir(), "beetl-connect-"));
  const path = join(directory, "integration.mjs");
  try {
    await writeFile(path, bundle);
    const module = (await import(`${pathToFileURL(path).href}?${crypto.randomUUID()}`)) as {
      default?: unknown;
    };
    if (!module.default || typeof module.default !== "object") {
      throw new Error(`${source} must default-export an integration`);
    }
    return module.default as IntegrationDefinition;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function resolveIntegrationEntry(inputPath: string): Promise<string> {
  const path = resolve(inputPath);
  return (await stat(path)).isDirectory() ? join(path, "integration.ts") : path;
}

function pathWithin(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return (
    child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child)
  );
}

async function validateIntegrationIcon(entryPath: string, declared: string | undefined) {
  if (declared === undefined) return;
  if (declared !== "icon.png" && declared !== "icon.webp") {
    throw new Error("Integration icon must be icon.png or icon.webp beside integration.ts");
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(dirname(entryPath), declared)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Integration declares missing ${declared}`);
    }
    throw error;
  }
  assertSize(declared, bytes, Limits.icon);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const valid =
    declared === "icon.png"
      ? bytes.length >= 33 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
          (byte, index) => bytes[index] === byte,
        ) &&
        view.getUint32(8) === 13 &&
        decoder.decode(bytes.subarray(12, 16)) === "IHDR" &&
        view.getUint32(16) > 0 &&
        view.getUint32(20) > 0
      : bytes.length >= 20 &&
        decoder.decode(bytes.subarray(0, 4)) === "RIFF" &&
        view.getUint32(4, true) + 8 === bytes.length &&
        decoder.decode(bytes.subarray(8, 12)) === "WEBP" &&
        ["VP8 ", "VP8L", "VP8X"].includes(decoder.decode(bytes.subarray(12, 16)));
  if (!valid) throw new Error(`${declared} does not contain a valid ${declared.slice(5)} image`);
}

function assertSize(name: string, bytes: Uint8Array, maximum: number): void {
  if (bytes.byteLength > maximum) {
    throw new Error(`${name} exceeds ${Math.floor(maximum / 1024 / 1024)} MiB`);
  }
}

async function typeCheckIntegration(entryPath: string): Promise<void> {
  const configPath = join(dirname(entryPath), "tsconfig.json");
  let configured: ts.CompilerOptions = {};
  if (ts.sys.fileExists(configPath)) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error !== undefined) throw typeScriptError([read.error], dirname(entryPath));
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      dirname(configPath),
      undefined,
      configPath,
    );
    const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
    if (errors.length > 0) throw typeScriptError(errors, dirname(entryPath));
    configured = parsed.options;
  }

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...configured,
    allowImportingTsExtensions: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    strict: true,
    types: ["node"],
    typeRoots: [NodeTypesDirectory, ...(configured.typeRoots ?? [])],
    paths: {
      ...configured.paths,
      "@beetlio/connect": [SdkTypesEntry],
    },
  };
  const diagnostics = ts
    .getPreEmitDiagnostics(ts.createProgram([entryPath], options))
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) throw typeScriptError(diagnostics, dirname(entryPath));
}

function typeScriptError(diagnostics: readonly ts.Diagnostic[], directory: string): Error {
  return new Error(
    `TypeScript check failed:\n${ts
      .formatDiagnostics(diagnostics, {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => directory,
        getNewLine: () => "\n",
      })
      .trim()}`,
  );
}

async function integrationBuildError(error: unknown, entryPath: string): Promise<Error> {
  if (!(error instanceof Error && "errors" in error && Array.isArray(error.errors))) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const messages = await formatMessages(error.errors, { kind: "error", color: false });
  const missingDependency = error.errors.some((message) => {
    const specifier = /^Could not resolve "([^"]+)"/.exec(message.text)?.[1];
    return (
      specifier !== undefined &&
      specifier !== basename(entryPath) &&
      !specifier.startsWith(".") &&
      !isAbsolute(specifier) &&
      !specifier.includes(":")
    );
  });
  const hint = missingDependency ? "\nInstall dependencies with `npm install` and retry." : "";
  return new Error(`${messages.join("").trim()}${hint}`, { cause: error });
}
