import path from "node:path";
import { defineConfig, type Plugin, type UserConfig } from "vite";

const HOSTED_MODE = "hosted";
const NUL = String.fromCharCode(0);
const HOSTED_PUBLIC_DEFAULT_ID = `${NUL}hosted-public-default`;

function stripId(id: string): string {
  let clean = id;
  while (clean.startsWith(NUL)) clean = clean.slice(1);
  return clean.split("?")[0] ?? "";
}

// Case-folded, forward-slash absolute id for comparison only; never logged.
function canonicalId(id: string): string {
  return path.resolve(stripId(id)).split(path.sep).join("/").toLowerCase();
}

// Hosted-only: the private native profile JSON is replaced in the module graph by a
// virtual module re-exporting the neutral public factory. Nothing is read from disk.
function hostedPublicProfilePlugin(): Plugin {
  let privateProfileId = "";
  let publicProviderPath = "";
  return {
    name: "hosted:public-default-profile",
    enforce: "pre",
    configResolved(config) {
      privateProfileId = canonicalId(path.resolve(config.root, "..", "profiles", "synesthesia.json"));
      publicProviderPath = path.resolve(config.root, "src", "profiles", "PublicDefaultProfile.ts").split(path.sep).join("/");
    },
    resolveId(source, importer) {
      const request = stripId(source);
      let candidate: string | null = null;
      if (path.isAbsolute(request)) candidate = request;
      else if (importer && request.startsWith(".")) candidate = path.resolve(path.dirname(stripId(importer)), request);
      if (candidate !== null && canonicalId(candidate) === privateProfileId) return HOSTED_PUBLIC_DEFAULT_ID;
      return null;
    },
    load(id) {
      if (id === HOSTED_PUBLIC_DEFAULT_ID) {
        return `import { publicDefaultProfile } from ${JSON.stringify(publicProviderPath)};\nexport default publicDefaultProfile();\n`;
      }
      if (canonicalId(id) === privateProfileId) this.error("Hosted build blocked: private profile reached the loader.");
      return null;
    },
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (canonicalId(id) === privateProfileId) this.error("Hosted build blocked: private profile is in the module graph.");
      }
    },
  };
}

export default defineConfig(({ mode }): UserConfig => {
  if (mode !== HOSTED_MODE) {
    return {
      build: {
        // Three.js is the renderer core; the production bundle is about 137 KB gzip.
        chunkSizeWarningLimit: 600,
      },
    };
  }
  return {
    envDir: false,
    plugins: [hostedPublicProfilePlugin()],
    build: {
      outDir: "dist-hosted",
      emptyOutDir: true,
      sourcemap: false,
      copyPublicDir: false,
      chunkSizeWarningLimit: 600,
    },
  };
});
