import { billLabel, compareBills } from "./compare.ts";
import type { BillDetail } from "./types.ts";
import { assertEquals } from "@std/assert";

function makeDetail(overrides: Partial<BillDetail> = {}): BillDetail {
  return {
    congress: 119,
    type: "hr",
    number: 1,
    title: "Example Act",
    updateDate: "2026-09-01",
    url: "https://api.congress.gov/v3/bill/119/hr/1",
    sponsors: [],
    subjects: [],
    actions: [],
    ...overrides,
  };
}

Deno.test("billLabel formats a bill reference", () => {
  assertEquals(billLabel({ congress: 119, type: "hr", number: 1234 }), "HR 1234 (119th Congress)");
});

Deno.test("compareBills flags differing and equal rows", () => {
  const a = makeDetail({ title: "Shared Title", cosponsorCount: 10 });
  const b = makeDetail({ number: 2, title: "Shared Title", cosponsorCount: 20 });
  const comparison = compareBills(a, b);
  const rows = new Map(comparison.rows.map((row) => [row.label, row]));
  assertEquals(rows.get("Title")?.differs, false);
  assertEquals(rows.get("Cosponsors")?.differs, true);
  assertEquals(rows.get("Cosponsors")?.a, "10");
  assertEquals(rows.get("Cosponsors")?.b, "20");
});

Deno.test("compareBills diffs the action lists", () => {
  const shared = { date: "2026-01-01", text: "Introduced." };
  const a = makeDetail({ actions: [shared, { date: "2026-02-01", text: "House vote." }] });
  const b = makeDetail({
    number: 2,
    actions: [shared, { date: "2026-03-01", text: "Senate vote." }],
  });
  const comparison = compareBills(a, b);
  assertEquals(comparison.actions.common, ["2026-01-01 — Introduced."]);
  assertEquals(comparison.actions.onlyA, ["2026-02-01 — House vote."]);
  assertEquals(comparison.actions.onlyB, ["2026-03-01 — Senate vote."]);
});
