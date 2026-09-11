import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire, setSourceMapsSupport } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";
import { create as createTar, extract as extractTar } from "tar";
import ts from "typescript";
import { z } from "zod";

import {
  createIntegrationManifest,
  type IntegrationDefinition,
  type IntegrationManifest,
} from "./index.ts";
import { assertSupportedHostContractVersion, validateIntegration } from "./host.ts";

const Require = createRequire(import.meta.url);

/** JSON inventory; resolve each artifact/source path relative to this URL. */
export const compatibilityFixturesUrl = new URL("./compatibility/inventory.json", import.meta.url);

const SdkEntry = fileURLToPath(new URL("./index.js", import.meta.url));
const SdkManifestEntry = fileURLToPath(new URL("./manifest.js", import.meta.url));
const SdkTypesEntry = fileURLToPath(new URL("./index.d.ts", import.meta.url));
const SdkVersion = z
  .object({ version: z.string().min(1) })
  .parse(Require("../package.json")).version;
const ZodDirectory = dirname(Require.resolve("zod/package.json"));
const NodeTypesDirectory = dirname(dirname(Require.resolve("@types/node/package.json")));
const Encoder = new TextEncoder();
const Limits = {
  archive: 25 * 1024 * 1024,
  expanded: 50 * 1024 * 1024,
  runtime: 100 * 1024 * 1024,
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
  type: z.string().optional(),
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
const Npm =
  process.platform === "win32"
    ? [process.execPath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
    : ["npm"];
setSourceMapsSupport(true);

export interface BuiltIntegrationIcon {
  readonly filename: "icon.png" | "icon.webp";
  readonly mediaType: "image/png" | "image/webp";
  readonly bytes: Uint8Array;
}

export interface BuiltIntegration {
  readonly archive: Uint8Array;
  readonly manifest: IntegrationManifest;
  readonly icon?: BuiltIntegrationIcon;
  readonly sdkVersion: string;
}

export interface PackedIntegration {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly files: readonly string[];
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
  if (packageDefinition.type !== "module") {
    throw new Error('Integration package.json requires "type": "module"');
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
      const result = await ExecFile(
        Npm[0]!,
        [
          ...Npm.slice(1),
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

export async function buildIntegration(inputPath: string): Promise<BuiltIntegration> {
  const directory = await realpath(resolve(inputPath));
  if (!(await stat(directory)).isDirectory()) {
    throw new Error("build requires an integration package directory");
  }
  const packed = await packIntegration(directory);
  const temporary = await mkdtemp(join(tmpdir(), "beetl-connect-build-"));
  try {
    const sourceArchive = join(temporary, packed.filename);
    const sourceDirectory = join(temporary, "source");
    const sourcePackage = join(sourceDirectory, "package");
    const runtimeDirectory = join(temporary, "runtime");
    const runtimePackage = join(runtimeDirectory, "package");
    await Promise.all([writeFile(sourceArchive, packed.bytes), mkdir(sourceDirectory)]);
    await extractTar({ cwd: sourceDirectory, file: sourceArchive, strict: true });

    try {
      if ((await stat(join(directory, "node_modules"))).isDirectory()) {
        await cp(join(directory, "node_modules"), join(sourcePackage, "node_modules"), {
          recursive: true,
        });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    await cp(sourcePackage, runtimePackage, {
      recursive: true,
      filter: (path) => {
        const child = relative(sourcePackage, path);
        return (
          child === "" ||
          (!child.split(/[/\\]/).includes("node_modules") && !/\.(?:[cm]?ts|tsx)$/.test(path))
        );
      },
    });
    await compileIntegration(sourcePackage, runtimePackage);
    await rename(join(sourcePackage, "node_modules"), join(runtimePackage, "node_modules")).catch(
      (error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      },
    );
    try {
      await ExecFile(
        Npm[0]!,
        [
          ...Npm.slice(1),
          "prune",
          "--omit=dev",
          "--ignore-scripts",
          "--offline",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: runtimePackage, encoding: "utf8", windowsHide: true },
      );
    } catch (error) {
      throw new Error("Could not prepare production dependencies", { cause: error });
    }

    const sdkDirectory = join(runtimePackage, "node_modules/@beetlio/connect");
    await rm(sdkDirectory, { recursive: true, force: true });
    await mkdir(sdkDirectory, { recursive: true });
    await Promise.all([
      copyFile(SdkEntry, join(sdkDirectory, "index.js")),
      copyFile(SdkManifestEntry, join(sdkDirectory, "manifest.js")),
      copyFile(new URL("./storage.js", import.meta.url), join(sdkDirectory, "storage.js")),
      copyFile(new URL("./batching.js", import.meta.url), join(sdkDirectory, "batching.js")),
      cp(ZodDirectory, join(sdkDirectory, "node_modules/zod"), { recursive: true }),
    ]);
    await writeFile(
      join(sdkDirectory, "package.json"),
      `${JSON.stringify({
        name: "@beetlio/connect",
        version: SdkVersion,
        type: "module",
        exports: "./index.js",
      })}\n`,
    );

    const evaluationPackage = join(temporary, "evaluation");
    await cp(runtimePackage, evaluationPackage, { recursive: true });
    const integration = await importIntegration(
      join(evaluationPackage, "integration.js"),
      inputPath,
    );
    validateIntegration(integration);
    const manifest = createIntegrationManifest(integration);
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
    assertSize("manifest.json", Encoder.encode(manifestSource), Limits.manifest);
    const icon = await loadIntegrationIcon(
      join(runtimePackage, "integration.js"),
      integration.icon,
    );
    await Promise.all([
      writeFile(join(runtimePackage, "manifest.json"), manifestSource),
      writeFile(
        join(runtimePackage, "integration.mjs"),
        `import { setSourceMapsSupport } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { createIntegrationManifest } from "@beetlio/connect";
setSourceMapsSupport(true);
const { default: integration } = await import("./integration.js");

if (!isDeepStrictEqual(createIntegrationManifest(integration), ${JSON.stringify(manifest)})) {
  throw new Error("Runtime integration definition does not match its build manifest");
}

export default integration;
`,
      ),
    ]);

    const archivePath = join(temporary, "integration-runtime.tgz");
    await createTar(
      {
        cwd: runtimeDirectory,
        file: archivePath,
        gzip: true,
        mtime: new Date(0),
        portable: true,
        strict: true,
      },
      ["package"],
    );
    const archive = new Uint8Array(await readFile(archivePath));
    assertSize("runtime artifact", archive, Limits.runtime);
    return {
      archive,
      manifest,
      ...(icon === undefined ? {} : { icon }),
      sdkVersion: SdkVersion,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function withIntegration<Value>(
  archive: Uint8Array,
  action: (integration: IntegrationDefinition) => Value | Promise<Value>,
): Promise<Value> {
  assertSize("runtime artifact", archive, Limits.runtime);
  const directory = await mkdtemp(join(tmpdir(), "beetl-connect-runtime-"));
  const archivePath = join(directory, "integration-runtime.tgz");
  try {
    await writeFile(archivePath, archive);
    await extractTar({ cwd: directory, file: archivePath, strict: true });

    const manifest = z
      .object({
        manifestVersion: z.unknown(),
        hostContractVersion: z.unknown().optional(),
      })
      .parse(JSON.parse(await readFile(join(directory, "package/manifest.json"), "utf8")));

    if (manifest.manifestVersion !== 2) {
      throw new Error(
        `Unsupported manifest version ${JSON.stringify(manifest.manifestVersion)}; supported: 2. Upgrade the execution host SDK or rebuild with a supported SDK.`,
      );
    }
    assertSupportedHostContractVersion(manifest.hostContractVersion);

    const integration = await importIntegration(
      join(directory, "package/integration.mjs"),
      "runtime artifact",
    );
    return await action(integration);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function importIntegration(path: string, source: string): Promise<IntegrationDefinition> {
  let module: { default?: unknown };
  try {
    module = (await import(`${pathToFileURL(path).href}?${crypto.randomUUID()}`)) as {
      default?: unknown;
    };
  } catch (error) {
    throw new Error(
      `Could not load ${source}${error instanceof Error ? `: ${error.message}` : ""}`,
      { cause: error },
    );
  }
  if (!module.default || typeof module.default !== "object") {
    throw new Error(`${source} must default-export an integration`);
  }
  return module.default as IntegrationDefinition;
}

async function loadIntegrationIcon(
  entryPath: string,
  declared: string | undefined,
): Promise<BuiltIntegrationIcon | undefined> {
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
  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: 4096 ** 2 });
    if ((await image.metadata()).format !== declared.slice(5)) throw new Error();
    await image.raw().toBuffer();
  } catch {
    throw new Error(`${declared} does not contain a valid ${declared.slice(5)} image`);
  }
  return {
    filename: declared,
    mediaType: declared === "icon.png" ? "image/png" : "image/webp",
    bytes,
  };
}

function assertSize(name: string, bytes: Uint8Array, maximum: number): void {
  if (bytes.byteLength > maximum) {
    throw new Error(`${name} exceeds ${Math.floor(maximum / 1024 / 1024)} MiB`);
  }
}

async function compileIntegration(sourceDirectory: string, outputDirectory: string): Promise<void> {
  const entryPath = join(sourceDirectory, "integration.ts");
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    allowImportingTsExtensions: true,
    declaration: false,
    exactOptionalPropertyTypes: true,
    inlineSources: true,
    noEmit: false,
    noEmitOnError: true,
    noUncheckedIndexedAccess: true,
    outDir: outputDirectory,
    rewriteRelativeImportExtensions: true,
    rootDir: sourceDirectory,
    skipLibCheck: true,
    sourceMap: true,
    sourceRoot: "beetl://source/",
    strict: true,
    types: ["node"],
    typeRoots: [NodeTypesDirectory],
    paths: {
      "@beetlio/connect": [SdkTypesEntry],
    },
  };
  const sourceFiles = ts.sys
    .readDirectory(sourceDirectory, [".ts", ".mts", ".cts"], ["node_modules"])
    .filter((path) => !path.replaceAll("\\", "/").includes("/node_modules/"));
  if (!sourceFiles.includes(entryPath))
    throw new Error("Integration package must include integration.ts");
  const program = ts.createProgram(sourceFiles, options);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) throw typeScriptError(diagnostics, sourceDirectory);
  const emitted = program.emit();
  const emitErrors = emitted.diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (emitErrors.length > 0) throw typeScriptError(emitErrors, sourceDirectory);
}

function typeScriptError(diagnostics: readonly ts.Diagnostic[], directory: string): Error {
  const hint = diagnostics.some((diagnostic) => diagnostic.code === 2307)
    ? "\nInstall dependencies with `npm install` and retry."
    : "";
  return new Error(
    `TypeScript check failed:\n${ts
      .formatDiagnostics(diagnostics, {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => directory,
        getNewLine: () => "\n",
      })
      .trim()}${hint}`,
  );
}
