/** Domain types. Source identifiers and timestamps are preserved for provenance. */

export interface BillRef {
  congress: number;
  /** Lower-case bill type code, e.g. "hr", "s", "hjres". */
  type: string;
  number: number;
}

export interface Action {
  date: string;
  text: string;
}

export interface Sponsor {
  name: string;
  party?: string;
  state?: string;
}

export interface BillSummary extends BillRef {
  retrievedAt?: string;
  title: string;
  updateDate: string;
  originChamber?: string;
  latestAction?: Action;
  /** Canonical congress.gov URL for the record. */
  url: string;
}

export interface BillDetail extends BillSummary {
  introducedDate?: string;
  sponsors: Sponsor[];
  cosponsorCount?: number;
  policyArea?: string;
  subjects: string[];
  actions: Action[];
  completeness?: {
    actions: "complete" | "partial" | "unavailable";
    subjects: "complete" | "partial" | "unavailable";
  };
}

export interface BillText {
  versionType: string;
  date?: string;
  sourceUrl: string;
  text: string;
  originalLength?: number;
  truncated?: boolean;
}

export function recordLimitations(bill: BillDetail): string[] {
  if (!bill.completeness) return [];
  return Object.entries(bill.completeness).flatMap(([field, state]) =>
    state === "complete" ? [] : [`${field}: ${state}; do not infer absence from missing data.`]
  );
}

export function textLimitations(text: BillText, maxChars = text.text.length): string[] {
  const included = Math.min(text.text.length, maxChars);
  return text.truncated || text.text.length > maxChars
    ? [
      `Text truncated: only the first ${included} characters of ${
        text.originalLength ?? text.text.length
      } are included; the remainder was omitted.`,
    ]
    : [];
}
