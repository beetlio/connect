import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, setSourceMapsSupport } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { build, formatMessages, type Metafile } from "esbuild";
import { unzipSync, zipSync, type Zippable } from "fflate";
import ts from "typescript";
import { z } from "zod";

import {
  createIntegrationManifest,
  type IntegrationDefinition,
  type IntegrationManifest,
} from "./index.ts";
import { validateIntegration } from "./host.ts";

const Package = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../package.json"));
const SdkEntry = fileURLToPath(new URL("./index.js", import.meta.url));
const SdkTypesEntry = fileURLToPath(new URL("./index.d.ts", import.meta.url));
const Epoch = new Date(1980, 0, 1);
const Encoder = new TextEncoder();
const Decoder = new TextDecoder();
const Limits = {
  archive: 25 * 1024 * 1024,
  expanded: 50 * 1024 * 1024,
  bundle: 15 * 1024 * 1024,
  artifact: 64 * 1024,
  manifest: 1024 * 1024,
  licenses: 4 * 1024 * 1024,
  icon: 512 * 1024,
} as const;
setSourceMapsSupport(true);

const ArtifactFileSchema = z.strictObject({
  bytes: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const ArtifactMetadataSchema = z.strictObject({
  artifactVersion: z.literal(1),
  sdkVersion: z.string().min(1),
  runtime: z.literal("deno"),
  files: z.record(z.string(), ArtifactFileSchema),
});
const NpmPackageSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  license: z.string().optional(),
});
const DependencyMapSchema = z.record(z.string(), z.string()).default({});
const ProjectPackageSchema = NpmPackageSchema.extend({
  dependencies: DependencyMapSchema,
  optionalDependencies: DependencyMapSchema,
});
const PackageLockSchema = z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(
    z.string(),
    z.object({
      version: z.string().optional(),
      dependencies: DependencyMapSchema,
      optionalDependencies: DependencyMapSchema,
    }),
  ),
});
type ArtifactFile = z.infer<typeof ArtifactFileSchema>;
type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

interface BuiltIntegration {
  readonly entryPath: string;
  readonly integration: IntegrationDefinition;
  readonly manifest: IntegrationManifest;
  readonly bundle: Uint8Array;
  readonly licenses: Uint8Array;
  readonly icon?: { readonly name: "icon.png" | "icon.webp"; readonly bytes: Uint8Array };
}

interface IntegrationArchive {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly manifest: IntegrationManifest;
}

export async function loadIntegration(inputPath: string): Promise<BuiltIntegration> {
  if (inputPath.endsWith(".beetl.zip")) {
    return loadArchive(resolve(inputPath));
  }
  return buildIntegration(inputPath);
}

export async function createIntegrationArchive(inputPath: string): Promise<IntegrationArchive> {
  if (inputPath.endsWith(".beetl.zip")) {
    throw new Error("pack requires integration source, not an existing artifact");
  }
  const built = await buildIntegration(inputPath);
  const files: Record<string, Uint8Array> = {
    "integration.mjs": built.bundle,
    "LICENSES.txt": built.licenses,
    "manifest.json": Encoder.encode(`${JSON.stringify(built.manifest)}\n`),
  };
  if (built.icon !== undefined) {
    files[built.icon.name] = built.icon.bytes;
  }
  const artifact: ArtifactMetadata = {
    artifactVersion: 1,
    sdkVersion: Package.version,
    runtime: "deno",
    files: Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((name) => [name, fileMetadata(files[name]!)]),
    ),
  };
  files["artifact.json"] = Encoder.encode(`${JSON.stringify(artifact)}\n`);
  const zippable: Zippable = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => [name, [files[name]!, { mtime: Epoch }]]),
  );
  const bytes = zipSync(zippable, { level: 9, mtime: Epoch });
  assertSize("archive", bytes, Limits.archive);
  return {
    bytes,
    filename: `${built.integration.key}.beetl.zip`,
    manifest: built.manifest,
  };
}

async function buildIntegration(inputPath: string): Promise<BuiltIntegration> {
  const entryPath = await resolveIntegrationEntry(inputPath);
  let output;
  try {
    output = await build({
      absWorkingDir: dirname(entryPath),
      entryPoints: [basename(entryPath)],
      outfile: "integration.mjs",
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2024",
      mainFields: ["module", "main"],
      sourcemap: "inline",
      sourcesContent: false,
      legalComments: "external",
      metafile: true,
      write: false,
      logLevel: "silent",
      logOverride: { "unsupported-dynamic-import": "error" },
      plugins: [
        {
          name: "beetl-connect-imports",
          setup(builder) {
            builder.onResolve({ filter: /^@beetlio\/connect$/ }, () => ({
              path: SdkEntry,
            }));
          },
        },
      ],
    });
  } catch (error) {
    throw await integrationBuildError(error, entryPath);
  }

  const bundle = output.outputFiles.find((file) => file.path.endsWith("integration.mjs"))?.contents;
  const legalComments = output.outputFiles.find((file) =>
    file.path.endsWith(".LEGAL.txt"),
  )?.contents;
  if (!bundle) throw new Error("Bundler did not produce integration.mjs");
  await validateLockedDependencies(entryPath, output.metafile);
  assertSize("integration.mjs", bundle, Limits.bundle);
  await typeCheckIntegration(entryPath);
  const integration = await importBundle(bundle, inputPath);
  validateIntegration(integration);
  const manifest = createIntegrationManifest(integration);
  assertSize("manifest.json", Encoder.encode(JSON.stringify(manifest)), Limits.manifest);
  const icon = await readIntegrationIcon(entryPath, integration.icon);
  const licenses = await collectLicenseNotices(
    dirname(entryPath),
    Object.keys(output.metafile.inputs),
    legalComments,
  );
  assertSize("LICENSES.txt", licenses, Limits.licenses);
  return {
    entryPath,
    integration,
    manifest,
    bundle,
    licenses,
    ...(icon === undefined ? {} : { icon }),
  };
}

async function loadArchive(path: string): Promise<BuiltIntegration> {
  const archive = new Uint8Array(await readFile(path));
  assertSize("archive", archive, Limits.archive);
  let expanded = 0;
  const names = new Set<string>();
  const allowed = new Set([
    "artifact.json",
    "manifest.json",
    "integration.mjs",
    "LICENSES.txt",
    "icon.png",
    "icon.webp",
  ]);
  const files = unzipSync(archive, {
    filter(file) {
      if (!allowed.has(file.name) || names.has(file.name)) {
        throw new Error(`Unexpected artifact entry ${JSON.stringify(file.name)}`);
      }
      names.add(file.name);
      expanded += file.originalSize;
      if (expanded > Limits.expanded) throw new Error("Artifact expands beyond 50 MiB");
      return true;
    },
  });
  for (const required of ["artifact.json", "manifest.json", "integration.mjs", "LICENSES.txt"]) {
    if (!files[required]) throw new Error(`Artifact is missing ${required}`);
  }
  assertSize("artifact.json", files["artifact.json"]!, Limits.artifact);
  assertSize("manifest.json", files["manifest.json"]!, Limits.manifest);
  assertSize("integration.mjs", files["integration.mjs"]!, Limits.bundle);
  assertSize("LICENSES.txt", files["LICENSES.txt"]!, Limits.licenses);
  if (files["icon.png"]) assertSize("icon.png", files["icon.png"], Limits.icon);
  if (files["icon.webp"]) assertSize("icon.webp", files["icon.webp"], Limits.icon);
  let metadata: unknown;
  let manifest: unknown;
  try {
    metadata = JSON.parse(Decoder.decode(files["artifact.json"]!));
  } catch (error) {
    throw new Error("artifact.json is not valid JSON", { cause: error });
  }
  const artifact = ArtifactMetadataSchema.safeParse(metadata);
  if (!artifact.success) {
    throw new Error(`Invalid artifact metadata: ${z.prettifyError(artifact.error)}`);
  }
  validateArtifactMetadata(artifact.data, files);
  try {
    manifest = JSON.parse(Decoder.decode(files["manifest.json"]!));
  } catch (error) {
    throw new Error("manifest.json is not valid JSON", { cause: error });
  }
  const integration = await importBundle(files["integration.mjs"]!, path);
  validateIntegration(integration);
  const inspectedManifest = createIntegrationManifest(integration);
  validateArchiveIcon(inspectedManifest.integration.icon, files);
  if (!isDeepStrictEqual(manifest, inspectedManifest)) {
    throw new Error("Artifact manifest does not match its integration bundle");
  }
  return {
    entryPath: path,
    integration,
    manifest: inspectedManifest,
    bundle: files["integration.mjs"]!,
    licenses: files["LICENSES.txt"]!,
  };
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

function validateArtifactMetadata(
  artifact: ArtifactMetadata,
  files: Readonly<Record<string, Uint8Array>>,
): void {
  const expected = Object.keys(files)
    .filter((name) => name !== "artifact.json")
    .sort();
  const actual = Object.keys(artifact.files).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("Artifact file list does not match artifact.json");
  }
  for (const name of expected) {
    const actual = fileMetadata(files[name]!);
    const declared = artifact.files[name];
    if (!declared || declared.bytes !== actual.bytes || declared.sha256 !== actual.sha256) {
      throw new Error(`Artifact digest mismatch for ${name}`);
    }
  }
}

function validateIconName(icon: string): "icon.png" | "icon.webp" {
  if (icon !== "icon.png" && icon !== "icon.webp") {
    throw new Error("Integration icon must be icon.png or icon.webp beside integration.ts");
  }
  return icon;
}

function validateArchiveIcon(
  expected: string | undefined,
  files: Readonly<Record<string, Uint8Array>>,
): void {
  for (const name of ["icon.png", "icon.webp"] as const) {
    const bytes = files[name];
    if (bytes !== undefined && name !== expected) {
      throw new Error(`Artifact contains undeclared ${name}`);
    }
  }
  if (expected !== undefined) {
    const name = validateIconName(expected);
    const bytes = files[name];
    if (bytes === undefined) throw new Error(`Artifact is missing ${name}`);
    validateIcon(name, bytes);
  }
}

function validateIcon(name: "icon.png" | "icon.webp", bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const valid =
    name === "icon.png"
      ? bytes.length >= 33 &&
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
          (byte, index) => bytes[index] === byte,
        ) &&
        view.getUint32(8) === 13 &&
        Decoder.decode(bytes.subarray(12, 16)) === "IHDR" &&
        view.getUint32(16) > 0 &&
        view.getUint32(20) > 0
      : bytes.length >= 20 &&
        Decoder.decode(bytes.subarray(0, 4)) === "RIFF" &&
        view.getUint32(4, true) + 8 === bytes.length &&
        Decoder.decode(bytes.subarray(8, 12)) === "WEBP" &&
        ["VP8 ", "VP8L", "VP8X"].includes(Decoder.decode(bytes.subarray(12, 16)));
  if (!valid) throw new Error(`${name} does not contain a valid ${name.slice(5)} image`);
}

async function readIntegrationIcon(
  entryPath: string,
  declared: string | undefined,
): Promise<BuiltIntegration["icon"]> {
  if (declared === undefined) return undefined;
  const name = validateIconName(declared);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(dirname(entryPath), name)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Integration declares missing ${name}`);
    }
    throw error;
  }
  assertSize(name, bytes, Limits.icon);
  validateIcon(name, bytes);
  return { name, bytes };
}

function fileMetadata(bytes: Uint8Array): ArtifactFile {
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertSize(name: string, bytes: Uint8Array, maximum: number): void {
  if (bytes.byteLength > maximum) {
    throw new Error(`${name} exceeds ${Math.floor(maximum / 1024 / 1024)} MiB`);
  }
}

async function validateLockedDependencies(entryPath: string, metafile: Metafile): Promise<void> {
  const workingDirectory = dirname(entryPath);
  let packageDirectory: string | undefined;
  let packageManifest: z.infer<typeof ProjectPackageSchema> | undefined;
  for (let directory = workingDirectory; ; directory = dirname(directory)) {
    try {
      packageManifest = ProjectPackageSchema.parse(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
      );
      packageDirectory = directory;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (dirname(directory) === directory) break;
  }

  const directDependencies = new Set<string>();
  const sdkDirectory = dirname(SdkEntry);
  for (const [input, metadata] of Object.entries(metafile.inputs)) {
    const inputPath = resolve(workingDirectory, input);
    const sdkRelative = relative(sdkDirectory, inputPath);
    const isSdk =
      sdkRelative !== ".." &&
      !sdkRelative.startsWith("../") &&
      !sdkRelative.startsWith("..\\") &&
      !isAbsolute(sdkRelative);
    if (isSdk || inputPath.replaceAll("\\", "/").split("/").includes("node_modules")) continue;
    for (const imported of metadata.imports) {
      const specifier = imported.original;
      if (
        specifier === undefined ||
        specifier === "@beetlio/connect" ||
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.includes(":")
      ) {
        continue;
      }
      const segments = specifier.split("/");
      directDependencies.add(
        specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!,
      );
    }
  }
  if (directDependencies.size === 0) return;
  if (packageDirectory === undefined || packageManifest === undefined) {
    throw new Error("Integrations with npm dependencies require a package.json");
  }

  const declared = {
    ...packageManifest.dependencies,
    ...packageManifest.optionalDependencies,
  };
  for (const dependency of directDependencies) {
    if (declared[dependency] === undefined) {
      throw new Error(
        `Dependency ${JSON.stringify(dependency)} must be declared in package.json dependencies`,
      );
    }
  }

  let lockDirectory: string | undefined;
  for (let directory = packageDirectory; ; directory = dirname(directory)) {
    try {
      await stat(join(directory, "package-lock.json"));
      lockDirectory = directory;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (dirname(directory) === directory) break;
  }
  if (lockDirectory === undefined) {
    throw new Error("Integrations with npm dependencies require a committed package-lock.json");
  }

  let lockValue: unknown;
  try {
    lockValue = JSON.parse(await readFile(join(lockDirectory, "package-lock.json"), "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${join(lockDirectory, "package-lock.json")}`, {
      cause: error,
    });
  }
  const parsedLock = PackageLockSchema.safeParse(lockValue);
  if (!parsedLock.success) {
    throw new Error(`Invalid package-lock.json: ${z.prettifyError(parsedLock.error)}`);
  }
  const lock = parsedLock.data;
  const projectKey = relative(lockDirectory, packageDirectory).replaceAll("\\", "/");
  const lockedProject = lock.packages[projectKey];
  if (lockedProject === undefined) {
    throw new Error("package-lock.json does not contain this integration package");
  }
  const lockedDeclarations = {
    ...lockedProject.dependencies,
    ...lockedProject.optionalDependencies,
  };
  for (const dependency of directDependencies) {
    if (lockedDeclarations[dependency] !== declared[dependency]) {
      throw new Error(
        `package-lock.json is out of date for dependency ${JSON.stringify(dependency)}`,
      );
    }
  }

  const packageRoots = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const inputPath = resolve(workingDirectory, input);
    const lockedRelative = relative(lockDirectory, inputPath);
    if (
      lockedRelative === ".." ||
      lockedRelative.startsWith("../") ||
      lockedRelative.startsWith("..\\") ||
      isAbsolute(lockedRelative) ||
      !lockedRelative.replaceAll("\\", "/").split("/").includes("node_modules")
    ) {
      continue;
    }
    const root = await findPackageRoot(inputPath);
    if (root !== undefined) packageRoots.add(root);
  }
  for (const root of packageRoots) {
    const key = relative(lockDirectory, root).replaceAll("\\", "/");
    const installed = NpmPackageSchema.parse(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    );
    const locked = lock.packages[key];
    if (installed.version === undefined || locked?.version !== installed.version) {
      throw new Error(
        `Installed dependency ${installed.name ?? key} is not pinned at this version in package-lock.json`,
      );
    }
  }
}

async function collectLicenseNotices(
  workingDirectory: string,
  inputs: readonly string[],
  legalComments: Uint8Array | undefined,
): Promise<Uint8Array> {
  const roots = new Set<string>();
  for (const input of inputs) {
    if (input.startsWith("<")) continue;
    const root = await findPackageRoot(resolve(workingDirectory, input));
    if (root !== undefined) roots.add(root);
  }

  const packages = await Promise.all(
    [...roots].map(async (root) => {
      const metadata = NpmPackageSchema.parse(
        JSON.parse(await readFile(join(root, "package.json"), "utf8")),
      );
      const name = metadata.name ?? basename(root);
      const version = metadata.version ?? "unknown";
      const license = metadata.license ?? "unspecified";
      const filenames = (await readdir(root))
        .filter((file) => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(file))
        .sort();
      const texts = await Promise.all(filenames.map((file) => readFile(join(root, file), "utf8")));
      return {
        key: `${name}@${version}`,
        text: `${name}@${version}\nDeclared license: ${license}${
          texts.length === 0 ? "" : `\n\n${texts.map((text) => text.trim()).join("\n\n")}`
        }`,
      };
    }),
  );
  const sections = packages
    .sort(({ key: left }, { key: right }) => (left < right ? -1 : left > right ? 1 : 0))
    .map(({ text }) => text);
  const comments = legalComments === undefined ? "" : Decoder.decode(legalComments).trim();
  if (comments) sections.push(`Bundled legal comments\n\n${comments}`);
  const text = sections.join("\n\n---\n\n");
  return Encoder.encode(text.endsWith("\n") ? text : `${text}\n`);
}

async function findPackageRoot(inputPath: string): Promise<string | undefined> {
  let directory = dirname(inputPath);
  while (true) {
    try {
      const metadata = NpmPackageSchema.parse(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
      );
      if (metadata.name !== undefined) return directory;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function typeCheckIntegration(entryPath: string): Promise<void> {
  const configPath = ts.findConfigFile(dirname(entryPath), ts.sys.fileExists);
  let configured: ts.CompilerOptions = {};
  if (configPath !== undefined) {
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
    types: [],
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
