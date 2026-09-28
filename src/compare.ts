/** Metadata comparison between two bill details. */

import { diffLines, type LineDiff } from "./diff.ts";
import type { BillDetail } from "./types.ts";

export interface ComparisonRow {
  label: string;
  a: string;
  b: string;
  differs: boolean;
}

export interface BillComparison {
  a: BillDetail;
  b: BillDetail;
  rows: ComparisonRow[];
  /** Diff of the action lists, keyed on "date — text". */
  actions: LineDiff;
}

/** Short display label for a bill reference. */
export function billLabel(bill: { congress: number; type: string; number: number }): string {
  return `${bill.type.toUpperCase()} ${bill.number} (${bill.congress}th Congress)`;
}

function latestActionText(detail: BillDetail): string {
  return detail.latestAction
    ? `${detail.latestAction.date}: ${detail.latestAction.text}`
    : "unavailable";
}

/** Compare two bill details field-by-field plus an actions diff. */
export function compareBills(a: BillDetail, b: BillDetail): BillComparison {
  const fields: Array<[string, string, string]> = [
    ["Title", a.title, b.title],
    ["Congress", String(a.congress), String(b.congress)],
    ["Origin chamber", a.originChamber ?? "unavailable", b.originChamber ?? "unavailable"],
    ["Introduced", a.introducedDate ?? "unavailable", b.introducedDate ?? "unavailable"],
    ["Last updated", a.updateDate || "unavailable", b.updateDate || "unavailable"],
    [
      "Cosponsors",
      String(a.cosponsorCount ?? "unavailable"),
      String(b.cosponsorCount ?? "unavailable"),
    ],
    ["Policy area", a.policyArea ?? "unavailable", b.policyArea ?? "unavailable"],
    ["Subjects", a.subjects.join(", ") || "unavailable", b.subjects.join(", ") || "unavailable"],
    ["Latest action", latestActionText(a), latestActionText(b)],
  ];
  const rows = fields.map(([label, valueA, valueB]) => ({
    label,
    a: valueA,
    b: valueB,
    differs: valueA !== valueB,
  }));
  const actions = diffLines(
    a.actions.map((action) => `${action.date} — ${action.text}`),
    b.actions.map((action) => `${action.date} — ${action.text}`),
  );
  return { a, b, rows, actions };
}
