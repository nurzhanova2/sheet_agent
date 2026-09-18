#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Stage 26.8 §49 — write SheetAgent_V2_Manual_Test.xlsx.
//
// The sheet DATA comes from apps/addin/src/app/schema/__fixtures__/manual-tables.ts
// by way of a JSON dump, so the workbook a human tests on and the tables the
// §42 smoke suite runs against are the same numbers. Usage:
//
//   node scripts/build-manual-workbook.mjs <sheets.json> <out.xlsx>
//
// No dependency: an .xlsx is a ZIP of OOXML parts, and Node has deflateRaw.
// Strings go in as inline strings (no shared-string table), which is valid and
// keeps this short.
//
// Dates matter here. A value like "2025-06-15" under a date number format is
// converted to a real Excel serial, because the whole point of §40's "no raw
// serial dates in answers" is that the workbook contains real serials and the
// engine still never shows one.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

// --- a minimal ZIP writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date: ((year-1980) << 9) | (month << 5) | day. A zero DAY (which
// 0x2100 encodes) makes some readers, Excel among them, offer to "repair" the
// file — so a real date, 2020-01-01.
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(0, 42 - 4); // external attrs at 38; relative offset at 42
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBuf]));
    offset += local.length + nameBuf.length + deflated.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dirBuf, end]);
}

// --- OOXML -------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function columnLetters(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const DATE_FORMAT = /(y{2,4}|d{1,2}|m{3,5})/i;
const EPOCH = Date.UTC(1899, 11, 30);

/** "2025-06-15" → 45823, so the workbook holds a real date, not a label. */
function excelSerial(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((ms - EPOCH) / 86_400_000);
}

function buildStyles(formats) {
  const custom = formats.filter((f) => f !== "General");
  const numFmts = custom.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join("");
  const xfs = ["<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"]
    .concat(custom.map((_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`))
    .concat(['<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'])
    .join("");
  const headerStyle = custom.length + 1;
  const styleIndex = new Map(custom.map((f, i) => [f, i + 1]));
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<numFmts count="${custom.length}">${numFmts}</numFmts>` +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${custom.length + 2}">${xfs}</cellXfs>` +
    "</styleSheet>";
  return { xml, styleIndex, headerStyle };
}

function buildSheet(sheet, styleIndex, headerStyle) {
  const rows = sheet.values
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === undefined || value === "") return "";
          const ref = `${columnLetters(c)}${r + 1}`;
          const fmt = sheet.numberFormats?.[r]?.[c] ?? "General";
          const isHeader = r === 0 || (typeof value === "string" && c === 0);
          let style = styleIndex.get(fmt) ?? 0;
          if (r === 0) style = headerStyle;
          if (typeof value === "number") return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
          if (DATE_FORMAT.test(fmt)) {
            const serial = excelSerial(String(value));
            if (serial !== null) return `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
          }
          return `<c r="${ref}" s="${isHeader && r === 0 ? headerStyle : 0}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
        })
        .join("");
      return cells === "" ? "" : `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const width = sheet.values.reduce((m, r) => Math.max(m, r.length), 0);
  const cols = `<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="${Math.max(2, width)}" width="15" customWidth="1"/></cols>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    cols +
    `<sheetData>${rows}</sheetData>` +
    "</worksheet>"
  );
}

function buildWorkbook(sheets) {
  const formats = [...new Set(sheets.flatMap((s) => (s.numberFormats ?? []).flat()))].filter(Boolean);
  const { xml: stylesXml, styleIndex, headerStyle } = buildStyles(formats);

  const sheetEntries = sheets.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: Buffer.from(buildSheet(s, styleIndex, headerStyle), "utf8"),
  }));

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<sheets>" +
    sheets.map((s, i) => `<sheet name="${esc(s.sheetName)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    "</Relationships>";

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(relsXml, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(stylesXml, "utf8") },
    ...sheetEntries,
  ]);
}

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/build-manual-workbook.mjs <sheets.json> <out.xlsx>");
  process.exit(2);
}
const sheets = JSON.parse(readFileSync(inPath, "utf8"));
const buffer = buildWorkbook(sheets);
writeFileSync(outPath, buffer);
console.log(`wrote ${outPath} — ${sheets.length} sheet(s), ${buffer.length} bytes`);
for (const s of sheets) console.log(`  ${s.sheetName}: ${s.values.length} row(s)`);
