// @vitest-environment node
// Hosted build contract: real Vite builds of the real config with write:false and
// pre-enforced guards, so the private native palette is never read from disk.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile, type Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { testProfile } from "../profiles/profile.test-fixtures";

const visualizerRoot = fileURLToPath(new URL("../../", import.meta.url));
const configFile = path.join(visualizerRoot, "vite.config.ts");
// Compared only as a normalized id; never read, printed, or asserted as a raw path.
const PRIVATE_PROFILE_ID = normalizeId(path.resolve(visualizerRoot, "..", "profiles", "synesthesia.json"));
const PUBLIC_PROVIDER_SUFFIX = "/src/profiles/publicdefaultprofile.ts";
const PRIVATE_SENTINEL = "PRIVATE_SENTINEL synthetic stand-in";
const BUILD_TIMEOUT_MS = 180_000;

type GuardMode = "deny" | "synthetic";

interface BuildProbe {
  moduleIds: Set<string>;
  privateLoads: number;
}

interface BuiltFile {
  type: string;
  fileName: string;
  code?: string;
  source?: unknown;
  map?: unknown;
}

function normalizeId(id: string): string {
  const withoutQuery = id.replace(/^\0+/, "").split("?")[0] ?? "";
  return withoutQuery.replaceAll("\\", "/").toLowerCase();
}

function privateProfileGuard(probe: BuildProbe, mode: GuardMode): Plugin {
  return {
    name: "test:private-profile-guard",
    enforce: "pre",
    // Runs before the default filesystem loader for the same id; never falls through to it.
    load(id) {
      if (normalizeId(id) !== PRIVATE_PROFILE_ID) return null;
      probe.privateLoads += 1;
      if (mode === "deny") throw new Error("Hosted build attempted to load the private profile");
      return JSON.stringify({ ...testProfile(), name: PRIVATE_SENTINEL });
    },
    transform(_code, id) {
      probe.moduleIds.add(normalizeId(id));
      return null;
    },
  };
}

async function buildApp(mode: string, guard: GuardMode): Promise<{ probe: BuildProbe; files: BuiltFile[]; failed: boolean }> {
  const probe: BuildProbe = { moduleIds: new Set(), privateLoads: 0 };
  const files: BuiltFile[] = [];
  try {
    const result = await build({
      root: visualizerRoot,
      configFile,
      mode,
      envDir: false,
      logLevel: "silent",
      plugins: [privateProfileGuard(probe, guard)],
      build: { write: false, emptyOutDir: false, copyPublicDir: false },
    });
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output)) throw new Error("Unexpected watch-mode build result");
      files.push(...output.output);
    }
    return { probe, files, failed: false };
  } catch {
    // Details intentionally dropped: build errors may echo absolute module paths.
    return { probe, files, failed: true };
  }
}

function bundleText(files: readonly BuiltFile[]): string {
  return files.map((file) => file.code ?? (typeof file.source === "string" ? file.source : "")).join("\n");
}

function hasModule(probe: BuildProbe, predicate: (id: string) => boolean): boolean {
  return [...probe.moduleIds].some(predicate);
}

describe("hosted public build contract", () => {
  it("hosted mode never loads the private profile, includes the public provider, and emits no sourcemaps", async () => {
    const { probe, files, failed } = await buildApp("hosted", "deny");

    expect(probe.privateLoads, "private profile load attempts").toBe(0);
    expect(failed, "hosted build failed").toBe(false);
    expect(hasModule(probe, (id) => id === PRIVATE_PROFILE_ID), "private profile in module graph").toBe(false);
    expect(hasModule(probe, (id) => id.endsWith(PUBLIC_PROVIDER_SUFFIX)), "public provider in module graph").toBe(true);
    expect(files.some((file) => file.fileName.endsWith(".map")), "sourcemap asset emitted").toBe(false);
    expect(files.every((file) => file.map == null), "no chunk sourcemaps attached").toBe(true);
  }, BUILD_TIMEOUT_MS);

  it("default mode keeps native profile resolution while hosted mode does not (synthetic stand-in only)", async () => {
    const native = await buildApp("production", "synthetic");
    const hosted = await buildApp("hosted", "synthetic");

    expect(native.failed, "default build failed").toBe(false);
    expect(native.probe.privateLoads > 0, "default build resolves native profile import").toBe(true);
    expect(bundleText(native.files).includes(PRIVATE_SENTINEL), "default bundle carries native default").toBe(true);

    expect(hosted.failed, "hosted build failed").toBe(false);
    expect(hosted.probe.privateLoads, "hosted native profile loads").toBe(0);
    expect(bundleText(hosted.files).includes(PRIVATE_SENTINEL), "hosted bundle carries native default").toBe(false);
  }, BUILD_TIMEOUT_MS * 2);

  it("hosted config targets a separate output without sourcemaps or env files; default output unchanged", async () => {
    const hosted = await loadConfigFromFile({ command: "build", mode: "hosted" }, configFile, visualizerRoot, "silent");
    const native = await loadConfigFromFile({ command: "build", mode: "production" }, configFile, visualizerRoot, "silent");

    expect(path.basename(String(hosted?.config.build?.outDir ?? ""))).toBe("dist-hosted");
    expect(hosted?.config.build?.sourcemap ?? false).toBe(false);
    expect(hosted?.config.envDir).toBe(false);
    expect(native?.config.build?.outDir ?? "dist").toBe("dist");
  });
});
