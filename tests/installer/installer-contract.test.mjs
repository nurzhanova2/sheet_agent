import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const manifests = ["manifest.dev.xml", "manifest.prod.xml", "manifest.windows.xml"];

test("Office manifests register the complete AI custom function surface", async () => {
  for (const name of manifests) {
    const xml = await readFile(new URL(`../../apps/addin/manifest/${name}`, import.meta.url), "utf8");
    assert.match(xml, /<Set Name="ExcelApi" MinVersion="1\.2"\/>/);
    assert.match(xml, /<bt:Set Name="CustomFunctionsRuntime"\/>/);
    assert.match(xml, /<ExtensionPoint xsi:type="CustomFunctions">/);
    assert.match(xml, /<Namespace resid="CustomFunctions\.Namespace"\/>/);
    assert.match(xml, /DefaultValue="AI"/);
    assert.match(xml, /assets\/customFunctions\.js/);
  }
});

test("custom-function metadata and JavaScript associations remain aligned", async () => {
  const metadata = JSON.parse(await readFile(new URL("../../apps/addin/public/custom-functions.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../../apps/addin/src/custom-functions/service.ts", import.meta.url), "utf8");
  const ids = metadata.functions.map((item) => item.id);
  assert.deepEqual(ids, ["ASK", "SUMMARIZE", "CLASSIFY", "EXTRACT", "TRANSLATE", "CLEAN"]);
  for (const id of ids) assert.match(source, new RegExp(`\\b${id}:`));
});

test("installer provides upgrade-safe setup and complete cleanup hooks", async () => {
  const iss = await readFile(new URL("../../installer/SheetAgent.utf8.iss", import.meta.url), "utf8");
  assert.match(iss, /OutputBaseFilename=SheetAgentSetup-x64/);
  assert.match(iss, /UsePreviousTasks=yes/);
  assert.match(iss, /uninsdeletevalue/);
  assert.match(iss, /remove-certificate\.ps1/);
  assert.match(iss, /\[UninstallDelete\]/);
});

test("installer fails closed when the localhost HTTPS certificate is missing", async () => {
  const iss = await readFile(new URL("../../installer/SheetAgent.utf8.iss", import.meta.url), "utf8");
  // Regression guard for the Stage 19 E2E bug: no localhost.pfx meant the Companion
  // silently served plain HTTP on 47831 and Excel could not load the add-in.
  assert.match(iss, /certificate\\localhost\.pfx/);
  assert.match(iss, /RaiseException/);
});

test("certificate provisioning does not double-specify the Subject Alternative Name", async () => {
  const script = await readFile(new URL("../../installer/scripts/new-local-certificate.ps1", import.meta.url), "utf8");
  const command = script.split("\n").find((line) => line.trimStart().startsWith("$certificate = New-SelfSignedCertificate"));
  assert.ok(command, "new-local-certificate.ps1 must invoke New-SelfSignedCertificate");
  // -DnsName together with a -TextExtension SAN makes New-SelfSignedCertificate throw.
  assert.doesNotMatch(command, /-DnsName/);
  assert.match(command, /2\.5\.29\.17=\{text\}DNS=localhost&IPAddress=127\.0\.0\.1/);
});

test("release build gates on the Companion serving HTTPS, not plain HTTP, on the loopback port", async () => {
  const build = await readFile(new URL("../../installer/build-installer.ps1", import.meta.url), "utf8");
  assert.match(build, /Test-CertificateProvisioning\.ps1/);
  assert.match(build, /Assert-CompanionHttps\.ps1/);
});

test("release build creates exact signed-release names and checksum", async () => {
  const build = await readFile(new URL("../../installer/build-installer.ps1", import.meta.url), "utf8");
  assert.match(build, /SheetAgentSetup-x64\.exe/);
  assert.match(build, /Get-AuthenticodeSignature/);
  assert.match(build, /\.sha256/);
  assert.match(build, /RequireSigning/);
});

test("packaged Windows manifest contains only the installed localhost production origin and real assets", async () => {
  const xml = await readFile(new URL("../../apps/addin/manifest/manifest.windows.xml", import.meta.url), "utf8");
  assert.doesNotMatch(xml, /localhost:3000|localhost:4000|example\.com/);
  for (const asset of ["taskpane.html", "commands.html", "custom-functions.html", "assets/customFunctions.js", "custom-functions.json", "assets/icon-16.png", "assets/icon-32.png", "assets/icon-80.png"]) assert.match(xml, new RegExp(asset.replace(".", "\\.")));
});

test("release workflow requires signing before publishing exact artifacts", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /-RequireSigning/);
  assert.match(workflow, /scan-defender\.ps1/);
  assert.match(workflow, /SheetAgentSetup-x64\.exe\.sha256/);
  assert.match(workflow, /gh release create/);
});
