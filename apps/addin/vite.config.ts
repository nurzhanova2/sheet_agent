import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Stage 24.5.2 §1/§17 — a provable, per-build identity so a manual tester can
// verify WHICH JS bundle Excel Desktop is actually executing.
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}
function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const BUILD_ID = process.env.SHEET_AGENT_BUILD_ID ?? new Date().toISOString();
const GIT_COMMIT = process.env.SHEET_AGENT_GIT_COMMIT ?? gitCommit();
const APP_VERSION = appVersion();

export default defineConfig({
  plugins: [basicSsl(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __GIT_COMMIT__: JSON.stringify(GIT_COMMIT),
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    https: {},
  },
  build: {
    rollupOptions: {
      input: {
        taskpane: fileURLToPath(new URL("./taskpane.html", import.meta.url)),
        commands: fileURLToPath(new URL("./commands.html", import.meta.url)),
        customFunctionsPage: fileURLToPath(new URL("./custom-functions.html", import.meta.url)),
        customFunctions: fileURLToPath(new URL("./src/custom-functions/main.ts", import.meta.url)),
      },
      output: {
        // Stage 24.5.2 §9/§17 — content-hash the taskpane bundle so every RC is
        // served from a NEW URL and Office/WebView2 can never replay a stale one.
        // `customFunctions` / `commands` keep fixed names — they are referenced by
        // fixed URLs from the manifest / commands.html.
        entryFileNames: (chunk) => (chunk.name === "taskpane" ? "assets/[name]-[hash].js" : "assets/[name].js"),
      },
    },
  },
});
