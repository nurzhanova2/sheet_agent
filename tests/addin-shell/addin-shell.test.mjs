import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFile(join(root, path), "utf8");

test("development and production manifests expose Task Pane and Ribbon command", async () => {
  for (const name of ["manifest.dev.xml", "manifest.prod.xml"]) {
    const manifest = await read(`apps/addin/manifest/${name}`);
    assert.match(manifest, /<Host Name="Workbook"\s*\/>/);
    assert.match(manifest, /ShowTaskpane/);
    assert.match(manifest, /AI Assistant/);
    assert.match(manifest, /<Permissions>ReadWriteDocument<\/Permissions>/);
    assert.match(manifest, /<bt:Url id="Taskpane.Url"/);
    assert.doesNotMatch(manifest, /DefaultValue="http:\/\/(?!localhost)/);
  }
});

test("add-in has isolated taskpane and commands host entries", async () => {
  const vite = await read("apps/addin/vite.config.ts");
  const packageJson = JSON.parse(await read("apps/addin/package.json"));
  assert.match(vite, /taskpane\.html/);
  assert.match(vite, /commands\.html/);
  assert.ok(packageJson.dependencies.react);
  assert.ok(packageJson.dependencies["@fluentui/react-components"]);
  assert.ok(packageJson.devDependencies.vite);
});

test("Office bootstrap waits for host readiness and exposes recoverable failure", async () => {
  const bootstrap = await read("apps/addin/src/app/office-bootstrap.ts");
  assert.match(bootstrap, /Office\.onReady/);
  assert.match(bootstrap, /HostType\.Excel/);
  assert.match(bootstrap, /timeout/i);
  assert.match(bootstrap, /unsupported/i);
});

test("capability service uses Office Requirement Sets instead of platform checks", async () => {
  const capabilities = await read("apps/addin/src/app/capabilities.ts");
  assert.match(capabilities, /isSetSupported/);
  assert.match(capabilities, /ExcelApi/);
  assert.doesNotMatch(capabilities, /navigator\.platform|Win32|MacIntel/);
});

test("task pane shell provides accessible landmarks and controls", async () => {
  const app = await read("apps/addin/src/taskpane/App.tsx");
  assert.match(app, /<header/);
  assert.match(app, /<main/);
  assert.match(app, /<form/);
  assert.match(app, /aria-live="polite"/);
  assert.match(app, /aria-label=/);
  assert.match(app, /Send24Regular/);
});

test("styles support narrow panes, keyboard focus and reduced motion", async () => {
  const styles = await read("apps/addin/src/taskpane/styles.css");
  assert.match(styles, /min-width:\s*0/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(styles, /transition:\s*all/);
  assert.doesNotMatch(styles, /ease-in[; ,]/);
});

test("stage 02 contains platform installation and smoke-test documentation", async () => {
  const guide = await read("documentation/ADDIN_DEVELOPMENT.md");
  for (const platform of ["Windows", "Excel Web", "macOS"]) {
    assert.match(guide, new RegExp(platform));
  }
  assert.match(guide, /HTTPS/);
  assert.match(guide, /manifest\.dev\.xml/);
  assert.match(guide, /smoke/i);
});
