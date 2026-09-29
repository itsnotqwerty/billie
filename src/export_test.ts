import {
  analysisToMarkdown,
  billTextToMarkdown,
  billToMarkdown,
  comparisonAnalysisToMarkdown,
  comparisonTextToMarkdown,
  comparisonToMarkdown,
  markdownToPlainText,
  markdownToTypst,
  serializeExport,
} from "./export.ts";
import { compareBills } from "./compare.ts";
import type { BillDetail } from "./types.ts";
import { assertEquals } from "@std/assert";

function bill(type: string, number: number, title: string): BillDetail {
  return {
    congress: 119,
    type,
    number,
    title,
    updateDate: "2026-09-01",
    url: `https://api.congress.gov/v3/bill/119/${type}/${number}`,
    sponsors: [],
    subjects: [],
    actions: [],
  };
}

Deno.test("comparisonAnalysisToMarkdown includes question, scope, and both sources", () => {
  const comparison = compareBills(
    bill("hr", 12, "House Wildfire Act"),
    bill("s", 34, "Senate Wildfire Act"),
  );
  const markdown = comparisonAnalysisToMarkdown(
    {
      summary: "The records differ in title.",
      keyProvisions: ["The titles differ."],
      affectedParties: [],
      uncertainties: ["Full bill text was not compared."],
    },
    comparison,
    "What is different?",
    "test-model",
    new Date("2026-09-28T00:00:00Z"),
  );

  assertEquals(markdown.includes("What is different?"), true);
  assertEquals(markdown.includes("supplied bill text versions"), true);
  assertEquals(markdown.includes(comparison.a.url), true);
  assertEquals(markdown.includes(comparison.b.url), true);
  assertEquals(markdown.includes("test-model"), true);
});

Deno.test("serializeExport supports every native format and style", async () => {
  const markdown = [
    "# Wildfire",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Title | A bill \\| act |",
  ].join("\n");
  const bundle = {
    title: "Wildfire <Record>",
    data: { kind: "bill", fields: { title: "A & B", text: 'quote, "word"' } },
    markdown,
    text: "Wildfire\n\nA & B\n",
  };

  assertEquals(await serializeExport(bundle, "markdown", "formatted"), bundle.markdown);
  assertEquals(await serializeExport(bundle, "markdown", "plain"), bundle.text);
  assertEquals(
    JSON.parse(await serializeExport(bundle, "json", "formatted") as string),
    bundle.data,
  );
  assertEquals((await serializeExport(bundle, "json", "plain") as string).includes("\n"), false);
  assertEquals(
    (await serializeExport(bundle, "xml", "formatted") as string).includes("A &amp; B"),
    true,
  );
  assertEquals((await serializeExport(bundle, "xml", "plain") as string).includes("\n"), false);
  assertEquals(
    (await serializeExport(bundle, "csv", "formatted") as string).startsWith("field,value\r\n"),
    true,
  );
  assertEquals(
    (await serializeExport(bundle, "csv", "formatted") as string).includes('"quote, ""word"""'),
    true,
  );
  assertEquals(
    (await serializeExport(bundle, "html", "formatted") as string).includes("<style>"),
    true,
  );
  assertEquals(
    (await serializeExport(bundle, "html", "plain") as string).includes("<style>"),
    false,
  );
  const html = await serializeExport(bundle, "html", "formatted") as string;
  assertEquals(html.includes("<table><thead><tr><th>Field</th><th>Value</th></tr></thead>"), true);
  assertEquals(html.includes("<td>A bill | act</td>"), true);
  assertEquals(html.includes("| --- |"), false);
  const typst = markdownToTypst(markdown, true);
  assertEquals(typst.includes("#table(columns: 2, stroke: 0.5pt, inset: 4pt,"), true);
  assertEquals(typst.includes('#strong[#text("Field")]'), true);
  assertEquals(typst.includes('#text("A bill | act")'), true);
  assertEquals(markdownToTypst("Field | Value\n--- | ---\nA | B", true).includes("#table("), true);

  const pdf = await serializeExport(bundle, "pdf", "formatted") as Uint8Array;
  const pdfText = new TextDecoder().decode(pdf);
  assertEquals(pdfText.startsWith("%PDF-"), true);
  assertEquals(pdf.length > 1000, true);
  const plainPdf = await serializeExport(bundle, "pdf", "plain") as Uint8Array;
  assertEquals(new TextDecoder().decode(plainPdf).startsWith("%PDF-"), true);
  assertEquals(markdownToPlainText("# Wildfire\n\n- **A & B**\n"), "Wildfire\n\nA & B\n");
});

Deno.test("comparisonTextToMarkdown preserves both full text columns", () => {
  const comparison = compareBills(
    bill("hr", 12, "House Wildfire Act"),
    bill("s", 34, "Senate Wildfire Act"),
  );
  const output = comparisonTextToMarkdown(
    comparison,
    { versionType: "Introduced", sourceUrl: "https://example.test/a", text: "A one\nA two" },
    { versionType: "Engrossed", sourceUrl: "https://example.test/b", text: "B one" },
  );
  assertEquals(output.includes("| A one | B one |"), true);
  assertEquals(output.includes("| A two |  |"), true);
  assertEquals(output.includes("https://example.test/a"), true);
  assertEquals(output.includes("https://example.test/b"), true);
});

Deno.test("exports disclose unavailable records and truncated text", async () => {
  const record = bill("hr", 1, "Incomplete record");
  record.completeness = { actions: "unavailable", subjects: "partial" };
  const comparison = compareBills(record, bill("s", 2, "Other record"));
  const text = {
    versionType: "Introduced",
    sourceUrl: "https://example.test/text",
    text: "excerpt",
    originalLength: 100,
    truncated: true,
  };
  const result = {
    summary: "Summary",
    keyProvisions: [],
    affectedParties: [],
    uncertainties: [],
    sourceLimitations: ["Text truncated"],
  };
  assertEquals(billToMarkdown(record).includes("actions: unavailable"), true);
  assertEquals(comparisonToMarkdown(comparison).includes("Action comparison unavailable"), true);
  assertEquals(billTextToMarkdown(record, text).includes("first 7 characters of 100"), true);
  assertEquals(
    comparisonTextToMarkdown(comparison, text, text).includes("Bill B: Text truncated"),
    true,
  );
  assertEquals(analysisToMarkdown(result, record, "test").includes("Text truncated"), true);
  assertEquals(
    comparisonAnalysisToMarkdown(result, comparison, "Why?", "test").includes("Text truncated"),
    true,
  );
  const bundle = {
    title: "Text",
    data: text,
    markdown: billTextToMarkdown(record, text),
    text: "Text truncated",
  };
  for (const format of ["json", "xml", "csv", "html"] as const) {
    const output = await serializeExport(bundle, format, "formatted") as string;
    assertEquals(output.includes(format === "html" ? "Text truncated" : "truncated"), true);
  }
});
