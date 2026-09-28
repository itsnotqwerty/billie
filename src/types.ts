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
}

export interface BillText {
  versionType: string;
  date?: string;
  sourceUrl: string;
  text: string;
}
