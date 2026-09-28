import {
  comparisonAnalysisToMarkdown,
  comparisonTextToMarkdown,
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
  const typst = markdownToTypst(markdown, true);
  assertEquals(typst.includes("#table(columns: 2, stroke: none,"), true);
  assertEquals(typst.includes("table.hline(y: 0, stroke: 0.8pt)"), true);
  assertEquals(typst.includes("table.hline(y: 1, stroke: 0.5pt)"), true);
  // Header + one body row = 2 rows; only top, under-header, and bottom rules.
  assertEquals(typst.includes("table.hline(y: 2, stroke: 0.8pt)"), true);
  assertEquals(typst.split("table.hline").length - 1, 3);
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
