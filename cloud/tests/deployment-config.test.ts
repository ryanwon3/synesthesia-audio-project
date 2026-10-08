import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("publishes only the hosted public-profile build, preserving native build output", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts;
  expect(manifest.buildCommand).toBe("npm run build:hosted");
  expect(manifest.outputDirectory).toBe("visualizer/dist-hosted");
  expect(scripts["build:hosted"]).toContain("--mode hosted");
  expect(scripts.build).not.toContain("--mode hosted");
  expect(manifest.routes.find((route: { headers?: Record<string, string> }) => route.headers?.["Content-Security-Policy"]))
    .toBeDefined();
  expect(manifest.routes.findIndex((route: { handle?: string }) => route.handle === "filesystem"))
    .toBeLessThan(manifest.routes.findIndex((route: { status?: number; src?: string }) => route.status === 404 && route.src?.startsWith("/api")));
});
