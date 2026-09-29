/** Native serializers for legislation records, comparisons, and analysis. */

import type { AnalysisResult } from "./ai/provider.ts";
import { Lexer, type Token, type Tokens } from "marked";
import { type BillComparison, billLabel } from "./compare.ts";
import { type BillDetail, type BillText, recordLimitations, textLimitations } from "./types.ts";

function limitationsToMarkdown(notices: string[]): string[] {
  return notices.length > 0
    ? ["", "## Source limitations", "", ...notices.map((notice) => `- ${notice}`), ""]
    : [];
}

/** Render a bill detail as a self-contained Markdown document. */
export function billToMarkdown(bill: BillDetail, retrievedAt: Date = new Date()): string {
  const label = `${bill.type.toUpperCase()} ${bill.number} — ${bill.congress}th Congress`;
  const lines: string[] = [
    `# ${label}`,
    "",
    bill.title,
    ...limitationsToMarkdown(recordLimitations(bill)),
    "",
    "## Metadata",
    "",
    `- Introduced: ${bill.introducedDate ?? "unavailable"}`,
    `- Origin chamber: ${bill.originChamber ?? "unavailable"}`,
    `- Last updated: ${bill.updateDate || "unavailable"}`,
    `- Policy area: ${bill.policyArea ?? "unavailable"}`,
    `- Subjects: ${bill.subjects.join(", ") || "unavailable"}`,
    `- Cosponsors: ${bill.cosponsorCount ?? "unavailable"}`,
    "",
    "## Sponsors",
    "",
  ];
  if (bill.sponsors.length === 0) {
    lines.push("- unavailable");
  } else {
    for (const sponsor of bill.sponsors) {
      const tag = [sponsor.party, sponsor.state].filter(Boolean).join("-");
      lines.push(`- ${sponsor.name}${tag ? ` (${tag})` : ""}`);
    }
  }
  lines.push("", "## Latest action", "");
  if (bill.latestAction) {
    lines.push(`- ${bill.latestAction.date}: ${bill.latestAction.text}`);
  } else {
    lines.push("- unavailable");
  }
  lines.push("", "## Recent actions", "");
  if (bill.actions.length === 0) {
    lines.push("- unavailable");
  } else {
    for (const action of bill.actions) lines.push(`- ${action.date}: ${action.text}`);
  }
  lines.push(
    "",
    "## Provenance",
    "",
    `- Source: ${bill.url || "Congress.gov API"}`,
    `- Retrieved: ${retrievedAt.toISOString()}`,
    "",
    "_Data from the Congress.gov API. This document reproduces the authoritative record; " +
      "it is not legal advice._",
    "",
  );
  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render a bill comparison as a self-contained Markdown document. */
export function comparisonToMarkdown(
  comparison: BillComparison,
  retrievedAt: Date = new Date(),
): string {
  const labelA = billLabel(comparison.a);
  const labelB = billLabel(comparison.b);
  const lines: string[] = [
    `# Comparison: ${labelA} vs ${labelB}`,
    ...limitationsToMarkdown(comparison.limitations),
    "",
    "| Field | A | B |",
    "| --- | --- | --- |",
  ];
  for (const row of comparison.rows) {
    const marker = row.differs ? " *(differs)*" : "";
    lines.push(`| ${row.label} | ${escapeCell(row.a)} | ${escapeCell(row.b)}${marker} |`);
  }
  lines.push("", `## Actions (${comparison.actions.common.length} shared)`, "");
  if (comparison.actions.onlyA.length > 0) {
    lines.push(`### Only in ${labelA}`, "");
    for (const action of comparison.actions.onlyA) lines.push(`- ${action}`);
    lines.push("");
  }
  if (comparison.actions.onlyB.length > 0) {
    lines.push(`### Only in ${labelB}`, "");
    for (const action of comparison.actions.onlyB) lines.push(`- ${action}`);
    lines.push("");
  }
  lines.push(
    "## Provenance",
    "",
    `- Source A: ${comparison.a.url || "Congress.gov API"}`,
    `- Source B: ${comparison.b.url || "Congress.gov API"}`,
    `- Retrieved: ${retrievedAt.toISOString()}`,
    "",
    "_Data from the Congress.gov API. This document reproduces the authoritative record; " +
      "it is not legal advice._",
    "",
  );
  return lines.join("\n");
}

/** Render an AI analysis as Markdown with a prominent generated-content notice. */
export function analysisToMarkdown(
  result: AnalysisResult,
  bill: BillDetail,
  model: string,
  retrievedAt: Date = new Date(),
): string {
  const lines: string[] = [
    `# AI analysis: ${billLabel(bill)}`,
    "",
    "> **Generated content** by `" + model + "`. This is an interpretation of the " +
    "> Congress.gov record and verbatim bill text, not the authoritative source. It is not legal advice.",
    "",
    bill.title,
    "",
    "## Summary",
    "",
    result.summary,
  ];
  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push("", `## ${title}`, "");
    for (const item of items) lines.push(`- ${item}`);
  };
  section("Key provisions", result.keyProvisions);
  section("Affected parties", result.affectedParties);
  section("Uncertainties", result.uncertainties);
  lines.push(...limitationsToMarkdown(result.sourceLimitations ?? recordLimitations(bill)));
  lines.push(
    "",
    "## Provenance",
    "",
    `- Source: ${bill.url || "Congress.gov API"}`,
    `- Retrieved: ${retrievedAt.toISOString()}`,
    `- Model: ${model}`,
    "",
  );
  return lines.join("\n");
}

/** Render an AI comparison answer with the question and provenance for both records. */
export function comparisonAnalysisToMarkdown(
  result: AnalysisResult,
  comparison: BillComparison,
  question: string,
  model: string,
  retrievedAt: Date = new Date(),
): string {
  const lines: string[] = [
    `# AI comparison: ${billLabel(comparison.a)} vs ${billLabel(comparison.b)}`,
    "",
    "> **Generated content** by `" + model + "`. This interpretation uses available record " +
    "> metadata, action history, and supplied bill text versions. It is not legal advice.",
    "",
    `**Question:** ${question}`,
    "",
    "## Summary",
    "",
    result.summary,
  ];
  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push("", `## ${title}`, "");
    for (const item of items) lines.push(`- ${item}`);
  };
  section("Key differences", result.keyProvisions);
  section("Affected parties", result.affectedParties);
  section("Uncertainties", result.uncertainties);
  lines.push(...limitationsToMarkdown(result.sourceLimitations ?? comparison.limitations));
  lines.push(
    "",
    "## Provenance",
    "",
    `- Source A: ${comparison.a.url || "Congress.gov API"}`,
    `- Source B: ${comparison.b.url || "Congress.gov API"}`,
    `- Retrieved: ${retrievedAt.toISOString()}`,
    `- Model: ${model}`,
    "",
  );
  return lines.join("\n");
}

/** Render verbatim bill text as Markdown, with provenance for both the text and the record. */
export function billTextToMarkdown(
  bill: BillDetail,
  billText: BillText,
  retrievedAt: Date = new Date(),
): string {
  const label = `${bill.type.toUpperCase()} ${bill.number} — ${bill.congress}th Congress`;
  const lines: string[] = [
    `# ${label} — Verbatim text`,
    "",
    `Version: ${billText.versionType}${billText.date ? ` (${billText.date})` : ""}`,
    ...limitationsToMarkdown(textLimitations(billText)),
    "",
    "## Provenance",
    "",
    `- Text source: ${billText.sourceUrl}`,
    `- Record source: ${bill.url || "Congress.gov API"}`,
    `- Retrieved: ${retrievedAt.toISOString()}`,
    "",
    "## Text",
    "",
    billText.text,
    "",
  ];
  return lines.join("\n");
}

export function comparisonTextToMarkdown(
  comparison: BillComparison,
  textA: BillText,
  textB: BillText,
): string {
  const labelA = billLabel(comparison.a);
  const labelB = billLabel(comparison.b);
  const lines = [
    `# Side-by-side text: ${labelA} vs ${labelB}`,
    ...limitationsToMarkdown([
      ...textLimitations(textA).map((notice) => `Bill A: ${notice}`),
      ...textLimitations(textB).map((notice) => `Bill B: ${notice}`),
    ]),
    "",
    `- ${labelA}: ${textA.versionType}${textA.date ? ` (${textA.date})` : ""}`,
    `- Source: ${textA.sourceUrl}`,
    `- ${labelB}: ${textB.versionType}${textB.date ? ` (${textB.date})` : ""}`,
    `- Source: ${textB.sourceUrl}`,
    "",
    `| ${escapeCell(labelA)} | ${escapeCell(labelB)} |`,
    "| --- | --- |",
  ];
  const left = textA.text.split("\n");
  const right = textB.text.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    lines.push(`| ${escapeCell(left[index] ?? "")} | ${escapeCell(right[index] ?? "")} |`);
  }
  return lines.join("\n") + "\n";
}

export type ExportFileType = "markdown" | "xml" | "json" | "csv" | "html" | "pdf";
export type ExportStyle = "plain" | "formatted";

export interface ExportBundle {
  title: string;
  data: unknown;
  markdown: string;
  text: string;
}

export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^\|(?:\s*:?-+:?\s*\|)+\s*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/^\|\s?/gm, "")
    .replace(/\s?\|\s?$/gm, "")
    .replace(/\s\|\s/g, "  |  ")
    .replace(/\n+$/g, "\n");
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    })[char]!);
}

function xmlNode(name: string, value: unknown, depth: number, formatted: boolean): string {
  const indent = formatted ? "  ".repeat(depth) : "";
  const newline = formatted ? "\n" : "";
  const tag = name.replace(/[^A-Za-z0-9_.-]/g, "_") || "item";
  if (value === null || typeof value !== "object") {
    return `${indent}<${tag}>${escapeXml(String(value ?? ""))}</${tag}>${newline}`;
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [`item${index + 1}`, item] as const)
    : Object.entries(value);
  if (entries.length === 0) return `${indent}<${tag}/>${newline}`;
  const children = entries.map(([key, child]) => xmlNode(key, child, depth + 1, formatted)).join(
    "",
  );
  return `${indent}<${tag}>${newline}${children}${indent}</${tag}>${newline}`;
}

function flatten(value: unknown, prefix = ""): Array<[string, string]> {
  if (value === null || typeof value !== "object") {
    return [[prefix || "value", String(value ?? "")]];
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [`${prefix}[${index}]`, item] as const)
    : Object.entries(value).map(([key, item]) =>
      [prefix ? `${prefix}.${key}` : key, item] as const
    );
  return entries.flatMap(([key, item]) => flatten(item, key));
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]!);
}

function inlineHtml(markdown: string): string {
  const render = (tokens: Token[] = []): string =>
    tokens.map((token): string => {
      switch (token.type) {
        case "strong":
          return `<strong>${render(token.tokens)}</strong>`;
        case "em":
          return `<em>${render(token.tokens)}</em>`;
        case "del":
          return `<del>${render(token.tokens)}</del>`;
        case "codespan":
          return `<code>${escapeHtml(token.text)}</code>`;
        case "br":
          return "<br>";
        case "link":
          return render(token.tokens);
        case "image":
          return escapeHtml(token.text);
        case "text":
          return token.tokens ? render(token.tokens) : escapeHtml(token.text);
        case "escape":
          return escapeHtml(token.text);
        default:
          return escapeHtml(token.raw);
      }
    }).join("");
  return render(Lexer.lexInline(markdown));
}

function markdownToHtml(markdown: string): string {
  const sourceLines = markdown.split("\n");
  const outputLines: string[] = [];
  for (let index = 0; index < sourceLines.length;) {
    const header = parseTableRow(sourceLines[index]);
    const separator = index + 1 < sourceLines.length ? parseTableRow(sourceLines[index + 1]) : null;
    if (header && separator && isTableSeparator(separator)) {
      const rows = [header];
      index += 2;
      while (index < sourceLines.length) {
        const row = parseTableRow(sourceLines[index]);
        if (!row) break;
        if (!isTableSeparator(row)) rows.push(row);
        index++;
      }
      outputLines.push(htmlTable(rows));
      continue;
    }

    const line = sourceLines[index++];
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      outputLines.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (item) {
      outputLines.push(`<p class="list-item">${inlineHtml(item[1])}</p>`);
      continue;
    }
    if (!line.trim()) {
      outputLines.push("");
      continue;
    }
    outputLines.push(`<p>${inlineHtml(line)}</p>`);
  }
  return outputLines.join("\n");
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const content = trimmed.slice(
    trimmed.startsWith("|") ? 1 : 0,
    trimmed.endsWith("|") ? -1 : undefined,
  );
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\\" && content[index + 1] === "|") {
      cell += "\u0000";
      index++;
    } else if (content[index] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += content[index];
    }
  }
  cells.push(cell.trim());
  return cells.length > 1 ? cells : null;
}

function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function htmlTable(rows: string[][]): string {
  const [header, ...body] = rows;
  const head = `<thead><tr>${
    header.map((cell) => `<th>${inlineHtml(cell.replaceAll("\u0000", "|"))}</th>`).join("")
  }</tr></thead>`;
  const bodyRows = body.map((row) =>
    `<tr>${
      row.map((cell) => `<td>${inlineHtml(cell.replaceAll("\u0000", "|"))}</td>`).join("")
    }</tr>`
  );
  return bodyRows.length > 0
    ? `<table>${head}<tbody>${bodyRows.join("")}</tbody></table>`
    : `<table>${head}</table>`;
}

function typstTable(rows: string[][]): string {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const cells = rows.flatMap((row, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => {
      const text = markdownToPlainText((row[columnIndex] ?? "").replaceAll("|", "\u0000"))
        .replaceAll("\u0000", "|").trim();
      const content = `#text(${JSON.stringify(text)})`;
      return rowIndex === 0 ? `[#strong[${content}]]` : `[${content}]`;
    })
  );
  return [
    `#table(columns: ${columnCount}, stroke: 0.5pt, inset: 4pt,`,
    ...cells.map((cell) => `  ${cell},`),
    ")",
  ].join("\n");
}

/** Convert Markdown blocks into escaped Typst markup, preserving table structure. */
export function markdownToTypst(markdown: string, formatted: boolean): string {
  const text = (value: string): string =>
    `#text(${JSON.stringify(markdownToPlainText(value).trimEnd())})`;
  const blocks = (tokens: Token[] = []): string =>
    tokens.map((token): string => {
      switch (token.type) {
        case "space":
          return "";
        case "table":
          return typstTable([
            token.header.map((cell: Tokens.TableCell) => cell.text),
            ...token.rows.map((row: Tokens.TableCell[]) => row.map((cell) => cell.text)),
          ]);
        case "heading":
          return formatted
            ? `#heading(level: ${token.depth})[${text(token.text)}]`
            : text(token.text);
        case "list": {
          const items = token.items.map((item: Tokens.ListItem) => blocks(item.tokens));
          if (!formatted) return items.join("\n\n");
          const kind = token.ordered ? `enum(start: ${token.start},` : "list(";
          return `#${kind}\n${items.map((item: string) => `[${item}],`).join("\n")}\n)`;
        }
        case "blockquote":
          return blocks(token.tokens);
        case "code":
          return `#text(${JSON.stringify(token.text)})`;
        default:
          return text("text" in token ? String(token.text) : token.raw);
      }
    }).join("\n\n");
  return ["#set page(margin: 18mm)", "#set text(size: 9pt)", "", blocks(Lexer.lex(markdown)), ""]
    .join("\n");
}

async function renderPdf(markdown: string, formatted: boolean): Promise<Uint8Array> {
  const tempDir = await Deno.makeTempDir({ prefix: "billie-pdf-" });
  try {
    const sourcePath = `${tempDir}/export.typ`;
    const pdfPath = `${tempDir}/export.pdf`;
    await Deno.writeTextFile(sourcePath, markdownToTypst(markdown, formatted));
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command("typst", {
        args: ["compile", sourcePath, pdfPath],
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to start Typst for PDF export. Install Typst and ensure it is on PATH. ${detail}`,
      );
    }
    if (!output.success) {
      const detail = new TextDecoder().decode(output.stderr).trim();
      throw new Error(
        `Typst PDF rendering failed: ${detail || `exit code ${output.code}`}`,
      );
    }
    return await Deno.readFile(pdfPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

export async function serializeExport(
  bundle: ExportBundle,
  fileType: ExportFileType,
  style: ExportStyle,
): Promise<string | Uint8Array> {
  switch (fileType) {
    case "markdown":
      return style === "formatted" ? bundle.markdown : bundle.text;
    case "json":
      return JSON.stringify(bundle.data, null, style === "formatted" ? 2 : undefined);
    case "xml": {
      const body = xmlNode("export", bundle.data, 0, style === "formatted");
      return style === "formatted"
        ? `<?xml version="1.0" encoding="UTF-8"?>\n${body}`
        : `<?xml version="1.0" encoding="UTF-8"?>${body.trim()}`;
    }
    case "csv":
      return [
        "field,value",
        ...flatten(bundle.data).map(([field, value]) => `${csvCell(field)},${csvCell(value)}`),
      ].join("\r\n");
    case "html": {
      const styleBlock = style === "formatted"
        ? "<style>body{font:16px/1.55 sans-serif;max-width:900px;margin:3rem auto;padding:0 1rem;color:#20252b}h1,h2,h3{line-height:1.2}p{white-space:pre-wrap}.list-item{padding-left:1.5rem}table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #c7ccd1;padding:0.3rem 0.6rem;text-align:left;vertical-align:top;white-space:pre-wrap}thead th{border-top:2px solid #20252b}tr:last-child td{border-bottom:2px solid #20252b}</style>"
        : "";
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${
        escapeHtml(bundle.title)
      }</title>${styleBlock}</head><body>${markdownToHtml(bundle.markdown)}</body></html>`;
    }
    case "pdf":
      return await renderPdf(bundle.markdown, style === "formatted");
  }
}

/** Write a serialized export under a unique name. Returns the path written. */
export async function exportMarkdown(
  dir: string,
  baseName: string,
  content: string,
  now: Date = new Date(),
): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/${baseName}-${stamp}.md`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content, { mode: 0o600 });
  return path;
}

export async function writeExport(
  dir: string,
  baseName: string,
  fileType: ExportFileType,
  content: string | Uint8Array,
  now: Date = new Date(),
): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/${baseName}-${stamp}.${fileType === "markdown" ? "md" : fileType}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(
    path,
    typeof content === "string" ? new TextEncoder().encode(content) : content,
    {
      mode: 0o600,
    },
  );
  return path;
}
