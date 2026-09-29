/** Congress.gov API v3 adapter. Validates external payloads at the boundary. */

import { stripHtml } from "../html.ts";
import type { Action, BillDetail, BillRef, BillSummary, BillText, Sponsor } from "../types.ts";

const BASE_URL = "https://api.congress.gov/v3";
const PAGE_SIZE = 250;
const MAX_SEARCH_PAGES = 6;
const MAX_MEMBER_PAGES = 20;
const MAX_SPONSOR_MATCHES = 20;
const MAX_SPONSORED_PAGES = 20;
const MAX_TEXT_LENGTH = 400_000;
const MAX_RETRY_AFTER_429 = 1;
const RETRY_DELAY_MS = 1_500;

export type FetchFn = (
  url: URL,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/** Fetches an arbitrary document URL without attaching the Congress.gov API key. */
export type RawFetchFn = (url: URL, init: { signal: AbortSignal }) => Promise<Response>;

export interface CongressClientOptions {
  apiKey: string;
  timeoutMs: number;
  rawFetchFn?: RawFetchFn;
  fetchFn?: FetchFn;
}

export class CongressApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CongressApiError";
  }
}

/** Congress number covering the given year: the 1st Congress began in 1789. */
export function congressForYear(year: number): number {
  return Math.floor((year - 1789) / 2) + 1;
}

export function currentCongress(now: Date = new Date()): number {
  return congressForYear(now.getUTCFullYear());
}

const BILL_REF_PATTERN = /^(hjres|sjres|hconres|sconres|hres|sres|hr|s)\s*(\d{1,5})$/i;

/** Detect direct bill references like "hr1234", "H.R. 5", or "s 301". */
export function detectBillRef(query: string): Omit<BillRef, "congress"> | null {
  const normalized = query.trim().replace(/\./g, "");
  const match = BILL_REF_PATTERN.exec(normalized);
  if (!match) return null;
  return { type: match[1].toLowerCase(), number: Number.parseInt(match[2], 10) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CongressApiError("Unexpected Congress.gov response shape.");
  }
  return value as Record<string, unknown>;
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed)) {
    throw new CongressApiError(`Missing numeric field "${key}" in Congress.gov response.`);
  }
  return parsed;
}

function parseAction(value: unknown): Action | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = str(record, "text");
  if (!text) return null;
  return { date: str(record, "actionDate"), text };
}

/** Parse one entry of the /bill list payload into a domain summary. */
export function parseBillSummary(value: unknown): BillSummary {
  const record = asRecord(value);
  const latestAction = record.latestAction ? parseAction(record.latestAction) : null;
  return {
    congress: num(record, "congress"),
    type: str(record, "type").toLowerCase(),
    number: num(record, "number"),
    title: str(record, "title") || "(untitled)",
    updateDate: str(record, "updateDate"),
    originChamber: str(record, "originChamber") || undefined,
    latestAction: latestAction ?? undefined,
    url: str(record, "url"),
  };
}

/** Parse the /bill/{congress}/{type}/{number} payload plus actions and subjects into a domain detail. */
export function parseBillDetail(
  billValue: unknown,
  actionsValue: unknown,
  subjectsValue?: unknown,
): BillDetail {
  const bill = asRecord(asRecord(billValue).bill);
  const summary = parseBillSummary(bill);
  const sponsors: Sponsor[] = [];
  if (Array.isArray(bill.sponsors)) {
    for (const raw of bill.sponsors) {
      const sponsor = asRecord(raw);
      sponsors.push({
        name: str(sponsor, "fullName") || "(unknown sponsor)",
        party: str(sponsor, "party") || undefined,
        state: str(sponsor, "state") || undefined,
      });
    }
  }
  const actions: Action[] = [];
  const actionList = asRecord(actionsValue).actions;
  if (Array.isArray(actionList)) {
    for (const raw of actionList) {
      const action = parseAction(raw);
      if (action) actions.push(action);
    }
  }
  const cosponsors = bill.cosponsors ? asRecord(bill.cosponsors) : null;
  const policyArea = bill.policyArea ? asRecord(bill.policyArea) : null;
  const subjects: string[] = [];
  if (subjectsValue !== null && subjectsValue !== undefined) {
    const subjectsRoot = asRecord(subjectsValue).subjects;
    const legislative = subjectsRoot && typeof subjectsRoot === "object"
      ? (subjectsRoot as Record<string, unknown>).legislativeSubjects
      : undefined;
    if (Array.isArray(legislative)) {
      for (const raw of legislative) {
        const name = str(asRecord(raw), "name");
        if (name) subjects.push(name);
      }
    }
  }
  return {
    ...summary,
    introducedDate: str(bill, "introducedDate") || undefined,
    sponsors,
    cosponsorCount: cosponsors && typeof cosponsors.count === "number"
      ? cosponsors.count
      : undefined,
    policyArea: policyArea ? str(policyArea, "name") || undefined : undefined,
    subjects,
    actions,
  };
}

export interface SearchOptions {
  congress?: number;
  type?: string | null;
  offset?: number;
}

export interface SearchResult {
  bills: BillSummary[];
  scanned: number;
  nextOffset?: number;
  limitations: string[];
}

function hasNextPage(root: Record<string, unknown>, offset: number, length: number): boolean {
  const pagination = root.pagination;
  if (pagination && typeof pagination === "object") {
    const page = pagination as Record<string, unknown>;
    if (page.next) return true;
    if (typeof page.count === "number") return offset + length < page.count;
  }
  return length === PAGE_SIZE;
}

export interface MemberSummary {
  bioguideId: string;
  name: string;
}

function parseMember(value: unknown): MemberSummary | null {
  const record = asRecord(value);
  const bioguideId = str(record, "bioguideId");
  const name = str(record, "name") || str(record, "directOrderName") ||
    str(record, "invertedOrderName");
  if (!bioguideId || !name) return null;
  return { bioguideId, name };
}

function dedupeBills(bills: BillSummary[]): BillSummary[] {
  const seen = new Set<string>();
  const result: BillSummary[] = [];
  for (const bill of bills) {
    const key = `${bill.congress}-${bill.type}-${bill.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(bill);
  }
  return result;
}

export class CongressClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly rawFetchFn: RawFetchFn;

  constructor(options: CongressClientOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.rawFetchFn = options.rawFetchFn ?? ((url, init) => fetch(url, init));
  }

  private async fetchJson(path: string, signal?: AbortSignal, attempt = 0): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    url.searchParams.set("format", "json");
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
        signal: combined,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CongressApiError("Request cancelled.");
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new CongressApiError(`Request timed out after ${this.timeoutMs} ms.`);
      }
      throw new CongressApiError(
        `Network error contacting Congress.gov: ${(error as Error).message}`,
      );
    }
    if (response.status === 429 && attempt < MAX_RETRY_AFTER_429 && !combined.aborted) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return this.fetchJson(path, signal, attempt + 1);
    }
    if (!response.ok) {
      const hint = response.status === 403
        ? " (check that your API key is valid)"
        : response.status === 429
        ? " (rate limited; try again later)"
        : "";
      throw new CongressApiError(
        `Congress.gov API error ${response.status}${hint}`,
        response.status,
      );
    }
    return await response.json();
  }

  /** List recently updated bills for a congress, one page at a time. Optionally filter by bill type. */
  async listBills(
    congress: number,
    offset: number,
    signal?: AbortSignal,
    type?: string | null,
  ): Promise<BillSummary[]> {
    return (await this.listBillPage(congress, offset, signal, type)).bills;
  }

  private async listBillPage(
    congress: number,
    offset: number,
    signal?: AbortSignal,
    type?: string | null,
  ): Promise<{ bills: BillSummary[]; more: boolean }> {
    const path = type ? `/bill/${congress}/${type}` : `/bill/${congress}`;
    const raw = await this.fetchJson(
      `${path}?limit=${PAGE_SIZE}&offset=${offset}&sort=updateDate+desc`,
      signal,
    );
    const bills = asRecord(raw).bills;
    if (!Array.isArray(bills)) {
      throw new CongressApiError("Congress.gov response did not include a bill list.");
    }
    return {
      bills: bills.map((bill) => ({
        ...parseBillSummary(bill),
        retrievedAt: new Date().toISOString(),
      })),
      more: hasNextPage(asRecord(raw), offset, bills.length),
    };
  }

  /** Fetch a single bill's summary without its actions/subjects (used for direct number lookups). */
  async getBillSummary(ref: BillRef, signal?: AbortSignal): Promise<BillSummary> {
    const raw = await this.fetchJson(`/bill/${ref.congress}/${ref.type}/${ref.number}`, signal);
    return { ...parseBillSummary(asRecord(raw).bill), retrievedAt: new Date().toISOString() };
  }

  /** Find current members whose name matches the query (client-side filtering). */
  async searchMembers(
    query: string,
    signal?: AbortSignal,
    congress?: number,
  ): Promise<MemberSummary[]> {
    return (await this.scanMembers(query, signal, congress)).members;
  }

  private async scanMembers(
    query: string,
    signal?: AbortSignal,
    congress?: number,
  ): Promise<{ members: MemberSummary[]; complete: boolean }> {
    const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) return { members: [], complete: true };
    const matches: MemberSummary[] = [];
    let more = false;
    for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
      signal?.throwIfAborted();
      const path = congress === undefined ? "/member" : `/member/congress/${congress}`;
      const raw = await this.fetchJson(
        `${path}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}${
          congress === undefined ? "&currentMember=true" : ""
        }`,
        signal,
      );
      const members = asRecord(raw).members;
      if (!Array.isArray(members)) {
        throw new CongressApiError("Congress.gov response did not include a member list.");
      }
      for (const item of members) {
        const member = parseMember(item);
        if (!member) continue;
        const haystack = member.name.toLowerCase();
        if (tokens.every((token) => haystack.includes(token))) matches.push(member);
      }
      more = hasNextPage(asRecord(raw), page * PAGE_SIZE, members.length);
      if (!more) break;
    }
    return { members: matches, complete: !more };
  }

  /** Bills sponsored by a member, restricted to the given congress. */
  async getSponsoredLegislation(
    bioguideId: string,
    congress: number,
    signal?: AbortSignal,
  ): Promise<BillSummary[]> {
    return (await this.scanSponsoredLegislation(bioguideId, congress, signal)).bills;
  }

  private async scanSponsoredLegislation(
    bioguideId: string,
    congress: number,
    signal?: AbortSignal,
  ): Promise<{ bills: BillSummary[]; complete: boolean }> {
    const summaries: BillSummary[] = [];
    let more = false;
    for (let page = 0; page < MAX_SPONSORED_PAGES; page++) {
      signal?.throwIfAborted();
      const record = asRecord(
        await this.fetchJson(
          `/member/${bioguideId}/sponsored-legislation?limit=${PAGE_SIZE}&offset=${
            page * PAGE_SIZE
          }`,
          signal,
        ),
      );
      const list = record.sponsoredLegislation;
      if (!Array.isArray(list)) {
        throw new CongressApiError("Congress.gov response did not include sponsored legislation.");
      }
      for (const item of list) {
        const summary = parseBillSummary(item);
        summary.retrievedAt = new Date().toISOString();
        if (summary.congress === congress) summaries.push(summary);
      }
      more = hasNextPage(record, page * PAGE_SIZE, list.length);
      if (!more) break;
    }
    return { bills: summaries, complete: !more };
  }

  /** Search by bill number/title (widened scan) merged with sponsor-name matches. A direct bill
   * reference (e.g. "hr5676") always resolves to that single bill so results stay browsable. */
  async searchBills(
    query: string,
    signal?: AbortSignal,
    options: SearchOptions = {},
  ): Promise<BillSummary[]> {
    return (await this.searchBillsWithCoverage(query, signal, options)).bills;
  }

  async searchBillsWithCoverage(
    query: string,
    signal?: AbortSignal,
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    const congress = options.congress ?? currentCongress();
    const ref = detectBillRef(query);
    if (ref) {
      const bill = await this.getBillSummary({ ...ref, congress }, signal);
      return {
        bills: options.type && bill.type !== options.type ? [] : [bill],
        scanned: 1,
        limitations: [],
      };
    }
    const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
    const titleMatches: BillSummary[] = [];
    const limitations: string[] = [];
    const offset = options.offset ?? 0;
    let scanned = 0;
    let nextOffset: number | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      signal?.throwIfAborted();
      const pageOffset = offset + page * PAGE_SIZE;
      const { bills, more } = await this.listBillPage(congress, pageOffset, signal, options.type);
      scanned += bills.length;
      for (const bill of bills) {
        const haystack = `${bill.type}${bill.number} ${bill.title}`.toLowerCase();
        if (tokens.every((token) => haystack.includes(token))) titleMatches.push(bill);
      }
      nextOffset = more ? pageOffset + PAGE_SIZE : undefined;
      if (!more) break;
    }
    let sponsorMatches: BillSummary[] = [];
    if (offset === 0) {
      try {
        const { members, complete } = await this.scanMembers(query, signal, congress);
        if (!complete) {
          limitations.push("Member scan reached its safety limit; sponsor coverage is partial.");
        }
        if (members.length > MAX_SPONSOR_MATCHES) {
          limitations.push(
            `Only the first ${MAX_SPONSOR_MATCHES} matching sponsors were searched; refine the name.`,
          );
        }
        for (const member of members.slice(0, MAX_SPONSOR_MATCHES)) {
          try {
            const result = await this.scanSponsoredLegislation(member.bioguideId, congress, signal);
            sponsorMatches.push(...result.bills);
            if (!result.complete) {
              limitations.push(
                `Sponsored legislation for ${member.name} reached its safety limit.`,
              );
            }
          } catch {
            signal?.throwIfAborted();
            limitations.push(`Sponsored legislation for ${member.name} is unavailable.`);
          }
        }
      } catch {
        signal?.throwIfAborted();
        limitations.push("Sponsor lookup unavailable; results include title matches only.");
      }
    }
    signal?.throwIfAborted();
    if (options.type) sponsorMatches = sponsorMatches.filter((bill) => bill.type === options.type);
    return {
      bills: dedupeBills([...titleMatches, ...sponsorMatches]),
      scanned,
      nextOffset,
      limitations,
    };
  }

  /** Fetch a single bill with its recent actions and subjects. */
  async getBillDetail(ref: BillRef, signal?: AbortSignal): Promise<BillDetail> {
    const path = `/bill/${ref.congress}/${ref.type}/${ref.number}`;
    const [bill, actions, subjects] = await Promise.all([
      this.fetchJson(path, signal),
      this.fetchJson(`${path}/actions?limit=${PAGE_SIZE}`, signal).catch(() => null),
      this.fetchJson(`${path}/subjects?limit=${PAGE_SIZE}`, signal).catch(() => null),
    ]);
    signal?.throwIfAborted();
    const actionsRoot = actions === null ? null : asRecord(actions);
    const subjectsRoot = subjects === null ? null : asRecord(subjects);
    const validActions = Array.isArray(actionsRoot?.actions);
    const subjectData = subjectsRoot?.subjects;
    const validSubjects = subjectData !== null && typeof subjectData === "object" &&
      Array.isArray((subjectData as Record<string, unknown>).legislativeSubjects);
    const detail = parseBillDetail(
      bill,
      validActions ? actions : { actions: [] },
      validSubjects ? subjects : null,
    );
    const hasMore = (root: Record<string, unknown> | null, length: number): boolean => {
      const pagination = root?.pagination;
      if (!pagination || typeof pagination !== "object") return length === PAGE_SIZE;
      const page = pagination as Record<string, unknown>;
      return Boolean(page.next) || (typeof page.count === "number" && page.count > length);
    };
    detail.completeness = {
      actions: !validActions
        ? "unavailable"
        : hasMore(actionsRoot, detail.actions.length)
        ? "partial"
        : "complete",
      subjects: !validSubjects
        ? "unavailable"
        : hasMore(subjectsRoot, detail.subjects.length)
        ? "partial"
        : "complete",
    };
    detail.retrievedAt = new Date().toISOString();
    return detail;
  }

  /** Fetch the most recent verbatim bill text (stripped to plain text) for manual/AI review. */
  async getBillText(ref: BillRef, signal?: AbortSignal): Promise<BillText> {
    const raw = await this.fetchJson(
      `/bill/${ref.congress}/${ref.type}/${ref.number}/text?limit=25`,
      signal,
    );
    const versions = asRecord(raw).textVersions;
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new CongressApiError("No verbatim text is available for this bill yet.");
    }
    const sorted = [...versions].sort((a, b) => {
      const dateA = Date.parse(str(asRecord(a), "date"));
      const dateB = Date.parse(str(asRecord(b), "date"));
      return (Number.isNaN(dateB) ? 0 : dateB) - (Number.isNaN(dateA) ? 0 : dateA);
    });
    for (const version of sorted) {
      const vRecord = asRecord(version);
      const formats = vRecord.formats;
      if (!Array.isArray(formats)) continue;
      const preferred = formats.find((f) => str(asRecord(f), "type") === "Formatted Text") ??
        formats.find((f) => str(asRecord(f), "type") === "Formatted XML");
      const url = preferred ? str(asRecord(preferred), "url") : "";
      if (!url) continue;
      const html = await this.fetchRawDocument(url, signal);
      const text = stripHtml(html);
      return {
        versionType: str(vRecord, "type") || "Unknown version",
        date: str(vRecord, "date") || undefined,
        sourceUrl: url,
        text: text.slice(0, MAX_TEXT_LENGTH),
        originalLength: text.length,
        truncated: text.length > MAX_TEXT_LENGTH,
      };
    }
    throw new CongressApiError("No readable text format is available for this bill yet.");
  }

  private async fetchRawDocument(url: string, signal?: AbortSignal): Promise<string> {
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      // No API key here: this request goes to a different host serving the public document.
      response = await this.rawFetchFn(new URL(url), { signal: combined });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CongressApiError("Request cancelled.");
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new CongressApiError(`Request timed out after ${this.timeoutMs} ms.`);
      }
      throw new CongressApiError(`Network error fetching bill text: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new CongressApiError(
        `Failed to fetch bill text (status ${response.status}).`,
        response.status,
      );
    }
    return await response.text();
  }
}
