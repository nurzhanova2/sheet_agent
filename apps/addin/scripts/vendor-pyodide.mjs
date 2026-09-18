// ---------------------------------------------------------------------------
// Stage 27 §8 — vendor the analytical runtime so it never needs the network.
//
// Pyodide fetches its wheels from a CDN by default. That is fine for a test
// run and unacceptable for the product: §8 says the sandbox is offline, and an
// add-in that silently downloads 25 MB of Python the first time a user asks
// for a correlation is neither offline nor predictable.
//
// This copies the runtime and exactly the wheels the declared stack needs out
// of node_modules and into `public/pyodide/`, where vite serves them and the
// installer stages them. The set is computed from `pyodide-lock.json` rather
// than hardcoded, so a dependency added upstream (scipy arriving under
// scikit-learn, say) is picked up instead of being discovered at runtime by a
// user with no internet.
//
//   node scripts/vendor-pyodide.mjs [--check]
//
// `--check` verifies the vendored copy is complete and current without
// writing, which is what the build runs before packaging.
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

/** §6 — the declared stack. Dependencies are resolved from the lock file. */
const ROOT_PACKAGES = ["numpy", "pandas", "scikit-learn"];

/** Files the runtime itself needs, whatever packages are loaded. */
const CORE_REQUIRED = ["pyodide.asm.wasm", "pyodide.asm.mjs", "pyodide.mjs", "python_stdlib.zip", "pyodide-lock.json"];

/**
 * Present in some Pyodide builds and not others (the classic-script entry
 * points come and go between releases). Copied when present, never demanded:
 * a release build must not fail because upstream dropped a file the module
 * entry point replaced.
 */
const CORE_OPTIONAL = ["pyodide.asm.js", "pyodide.js"];

function pyodideDir() {
  // Resolve through the package entry rather than guessing at node_modules
  // layout, which pnpm's store makes non-obvious.
  return path.dirname(require.resolve("pyodide/package.json"));
}

/** Transitive closure of the declared packages, from the lock file. */
function resolveWheels(lock) {
  const wanted = new Set();
  const queue = [...ROOT_PACKAGES];
  while (queue.length > 0) {
    const name = queue.pop();
    const entry = lock.packages[name];
    if (!entry || wanted.has(name)) continue;
    wanted.add(name);
    for (const dep of entry.depends ?? []) queue.push(dep);
  }
  return [...wanted].map((name) => lock.packages[name].file_name);
}

async function main() {
  const check = process.argv.includes("--check");
  const source = pyodideDir();
  const target = path.resolve(import.meta.dirname, "..", "public", "pyodide");

  const lock = JSON.parse(await readFile(path.join(source, "pyodide-lock.json"), "utf8"));
  const wheels = resolveWheels(lock);
  const required = [...CORE_REQUIRED, ...wheels];
  const files = [...required, ...CORE_OPTIONAL.filter((f) => existsSync(path.join(source, f)))];

  const missingFromSource = [];
  for (const file of required) {
    if (!existsSync(path.join(source, file))) missingFromSource.push(file);
  }
  // Wheels are downloaded on first use and cached into the package directory.
  // If they are absent, say exactly how to get them rather than failing with
  // a bare ENOENT during someone's release build.
  if (missingFromSource.length > 0 && !check) {
    const wheelsMissing = missingFromSource.filter((f) => f.endsWith(".whl"));
    if (wheelsMissing.length > 0) {
      console.error(
        `Missing ${wheelsMissing.length} wheel(s) in ${source}.\n` +
          `Pyodide caches them there on first use. Run the sandbox tests once with network access:\n` +
          `  npx vitest run src/analytical-engine-v2/sandbox.test.ts\n` +
          `then re-run this script.`,
      );
      process.exit(1);
    }
  }

  if (check) {
    const missingFromTarget = required.filter((f) => !existsSync(path.join(target, f)));
    if (missingFromTarget.length > 0) {
      console.error(`Vendored runtime is incomplete (${missingFromTarget.length} missing): ${missingFromTarget.slice(0, 5).join(", ")}…`);
      process.exit(1);
    }
    console.log(`Vendored Pyodide runtime is complete: ${files.length} files.`);
    return;
  }

  await mkdir(target, { recursive: true });
  let bytes = 0;
  for (const file of files) {
    const from = path.join(source, file);
    if (!existsSync(from)) continue;
    await cp(from, path.join(target, file));
    bytes += (await stat(from)).size;
  }

  // A trimmed lock file, so the runtime never looks for a package we did not
  // ship — an unavailable wheel must fail as UNSUPPORTED_LIBRARY (§68), never
  // as a silent CDN fetch.
  const shipped = new Set(wheels);
  const trimmed = {
    ...lock,
    packages: Object.fromEntries(Object.entries(lock.packages).filter(([, v]) => shipped.has(v.file_name))),
  };
  await writeFile(path.join(target, "pyodide-lock.json"), JSON.stringify(trimmed), "utf8");

  console.log(`Vendored ${files.length} files (${(bytes / 1048576).toFixed(1)} MB) into public/pyodide/`);
  console.log(`Packages: ${[...shipped].length} wheels for ${ROOT_PACKAGES.join(", ")} and their dependencies.`);
}

await main();
