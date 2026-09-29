import {
  CongressApiError,
  CongressClient,
  congressForYear,
  currentCongress,
  detectBillRef,
  type FetchFn,
  parseBillDetail,
  parseBillSummary,
  type RawFetchFn,
} from "./congress.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";

Deno.test("congressForYear maps years to congress numbers", () => {
  assertEquals(congressForYear(1789), 1);
  assertEquals(congressForYear(2025), 119);
  assertEquals(congressForYear(2026), 119);
});

Deno.test("currentCongress matches congressForYear for the current year", () => {
  const now = new Date(Date.UTC(2026, 8, 28));
  assertEquals(currentCongress(now), 119);
});

Deno.test("detectBillRef parses common bill references", () => {
  assertEquals(detectBillRef("hr1234"), { type: "hr", number: 1234 });
  assertEquals(detectBillRef("H.R. 5"), { type: "hr", number: 5 });
  assertEquals(detectBillRef("s 301"), { type: "s", number: 301 });
  assertEquals(detectBillRef("SJRES42"), { type: "sjres", number: 42 });
  assertEquals(detectBillRef("climate research"), null);
  assertEquals(detectBillRef(""), null);
});

const summaryFixture = {
  congress: 119,
  type: "HR",
  number: "1234",
  title: "Example Act of 2026",
  updateDate: "2026-09-01",
  originChamber: "House",
  latestAction: { actionDate: "2026-08-15", text: "Referred to the House Committee." },
  url: "https://api.congress.gov/v3/bill/119/hr/1234",
};

Deno.test("parseBillSummary normalizes a list entry", () => {
  const summary = parseBillSummary(summaryFixture);
  assertEquals(summary.congress, 119);
  assertEquals(summary.type, "hr");
  assertEquals(summary.number, 1234);
  assertEquals(summary.title, "Example Act of 2026");
  assertEquals(summary.latestAction, {
    date: "2026-08-15",
    text: "Referred to the House Committee.",
  });
});

Deno.test("parseBillSummary tolerates missing optional fields", () => {
  const summary = parseBillSummary({ congress: 119, type: "S", number: 1, title: "" });
  assertEquals(summary.title, "(untitled)");
  assertEquals(summary.latestAction, undefined);
});

Deno.test("parseBillSummary rejects non-object payloads", () => {
  assertThrows(() => parseBillSummary("nope"), CongressApiError);
});

Deno.test("parseBillDetail merges bill and actions payloads", () => {
  const bill = {
    bill: {
      ...summaryFixture,
      introducedDate: "2026-01-15",
      sponsors: [{ fullName: "Smith, Alex", party: "D", state: "CA" }],
      cosponsors: { count: 12 },
      policyArea: { name: "Science, Technology, Communications" },
    },
  };
  const actions = {
    actions: [
      { actionDate: "2026-08-15", text: "Referred to committee." },
      { actionDate: "2026-01-15", text: "Introduced in House." },
      { noText: true },
    ],
  };
  const detail = parseBillDetail(bill, actions);
  assertEquals(detail.introducedDate, "2026-01-15");
  assertEquals(detail.sponsors, [{ name: "Smith, Alex", party: "D", state: "CA" }]);
  assertEquals(detail.cosponsorCount, 12);
  assertEquals(detail.policyArea, "Science, Technology, Communications");
  assertEquals(detail.actions.length, 2);
  assertEquals(detail.actions[1].text, "Introduced in House.");
});

Deno.test("client sends the API key as a header and parses the list response", async () => {
  const seen: { url?: string; key?: string } = {};
  const fetchFn: FetchFn = (url, init) => {
    seen.url = url.toString();
    seen.key = init.headers["X-Api-Key"];
    return Promise.resolve(
      new Response(JSON.stringify({ bills: [summaryFixture] }), { status: 200 }),
    );
  };
  const client = new CongressClient({ apiKey: "test-key", timeoutMs: 1000, fetchFn });
  const bills = await client.listBills(119, 0);
  assertEquals(bills.length, 1);
  assertEquals(seen.key, "test-key");
  if (!seen.url?.includes("/bill/119") || !seen.url.includes("format=json")) {
    throw new Error(`unexpected URL: ${seen.url}`);
  }
  if (seen.url.includes("test-key")) {
    throw new Error("API key must not appear in the URL");
  }
});

Deno.test("client searchBills filters recent bills by all query tokens", async () => {
  const fetchFn: FetchFn = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          bills: [
            summaryFixture,
            { ...summaryFixture, number: "55", title: "Unrelated Measure" },
          ],
        }),
        { status: 200 },
      ),
    );
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn });
  const matches = await client.searchBills("example act");
  assertEquals(matches.map((bill) => bill.number), [1234]);
});

Deno.test("client surfaces HTTP errors with a status hint", async () => {
  const fetchFn: FetchFn = () => Promise.resolve(new Response("nope", { status: 403 }));
  const client = new CongressClient({ apiKey: "bad", timeoutMs: 1000, fetchFn });
  let caught: unknown;
  try {
    await client.listBills(119, 0);
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof CongressApiError)) throw new Error("expected CongressApiError");
  assertEquals(caught.status, 403);
});

Deno.test("listBills uses the type-filtered path when a type is given", async () => {
  const seen: { url?: string } = {};
  const fetchFn: FetchFn = (url) => {
    seen.url = url.toString();
    return Promise.resolve(new Response(JSON.stringify({ bills: [] }), { status: 200 }));
  };
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn });
  await client.listBills(119, 0, undefined, "hr");
  if (!seen.url?.includes("/bill/119/hr?")) {
    throw new Error(`unexpected URL: ${seen.url}`);
  }
});

Deno.test("parseBillDetail extracts legislative subjects", () => {
  const bill = { bill: summaryFixture };
  const subjects = {
    subjects: {
      legislativeSubjects: [{ name: "Emergency management" }, { name: "Wildfires" }, {}],
    },
  };
  const detail = parseBillDetail(bill, { actions: [] }, subjects);
  assertEquals(detail.subjects, ["Emergency management", "Wildfires"]);
  const noSubjects = parseBillDetail(bill, { actions: [] }, null);
  assertEquals(noSubjects.subjects, []);
});

Deno.test("searchBills resolves a direct bill number to a single browsable result", async () => {
  const seen: string[] = [];
  const fetchFn: FetchFn = (url) => {
    seen.push(url.pathname);
    return Promise.resolve(
      new Response(JSON.stringify({ bill: summaryFixture }), { status: 200 }),
    );
  };
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn });
  const results = await client.searchBills("H.R. 8800", undefined, { congress: 119 });
  assertEquals(results.length, 1);
  assertEquals(results[0].number, 1234);
  assertEquals(seen, ["/v3/bill/119/hr/8800"]);
});

Deno.test("getBillSummary fetches a single bill without actions/subjects", async () => {
  const fetchFn: FetchFn = () =>
    Promise.resolve(new Response(JSON.stringify({ bill: summaryFixture }), { status: 200 }));
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn });
  const summary = await client.getBillSummary({ congress: 119, type: "hr", number: 1234 });
  assertEquals(summary.title, "Example Act of 2026");
});

Deno.test("searchMembers filters by name substring across pages", async () => {
  const fetchFn: FetchFn = (url) => {
    const offset = url.searchParams.get("offset");
    const members = offset === "0"
      ? [{ bioguideId: "S001", name: "Smith, Jane" }, { bioguideId: "J002", name: "Jones, Amy" }]
      : [];
    return Promise.resolve(new Response(JSON.stringify({ members }), { status: 200 }));
  };
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn });
  const matches = await client.searchMembers("smith");
  assertEquals(matches, [{ bioguideId: "S001", name: "Smith, Jane" }]);
});

Deno.test("getSponsoredLegislation filters results to the requested congress", async () => {
  const fetchFn: FetchFn = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          sponsoredLegislation: [
            summaryFixture,
            { ...summaryFixture, congress: 118, number: "99" },
          ],
        }),
        { status: 200 },
      ),
    );
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn });
  const bills = await client.getSponsoredLegislation("S001", 119);
  assertEquals(bills.map((bill) => bill.number), [1234]);
});

Deno.test("searchBills merges title matches with sponsor matches and de-duplicates", async () => {
  const fetchFn: FetchFn = (url) => {
    if (url.pathname === "/v3/bill/119") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            bills: [{ ...summaryFixture, number: "55", title: "Unrelated Measure" }],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.pathname === "/v3/member/congress/119") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ members: [{ bioguideId: "S001", name: "Smith, Jane" }] }),
          { status: 200 },
        ),
      );
    }
    if (url.pathname === "/v3/member/S001/sponsored-legislation") {
      return Promise.resolve(
        new Response(JSON.stringify({ sponsoredLegislation: [summaryFixture] }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn });
  const results = await client.searchBills("smith", undefined, { congress: 119 });
  assertEquals(results.map((bill) => bill.number), [1234]);
});

Deno.test("getBillText picks the formatted-text version and strips HTML", async () => {
  const fetchFn: FetchFn = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          textVersions: [
            {
              type: "Introduced in House",
              date: "2026-01-15T00:00:00Z",
              formats: [
                { type: "PDF", url: "https://www.congress.gov/bill.pdf" },
                { type: "Formatted Text", url: "https://www.congress.gov/bill.htm" },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
  const rawFetchFn: RawFetchFn = (url) => {
    if (url.toString() !== "https://www.congress.gov/bill.htm") {
      throw new Error(`unexpected raw url: ${url}`);
    }
    return Promise.resolve(new Response("<p>Be it enacted</p>", { status: 200 }));
  };
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn, rawFetchFn });
  const text = await client.getBillText({ congress: 119, type: "hr", number: 1234 });
  assertEquals(text.text, "Be it enacted");
  assertEquals(text.sourceUrl, "https://www.congress.gov/bill.htm");
  assertEquals(text.versionType, "Introduced in House");
});

Deno.test("getBillText never sends the Congress.gov API key to the raw document host", async () => {
  const fetchFn: FetchFn = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          textVersions: [{
            type: "Enrolled Bill",
            date: "2026-01-15T00:00:00Z",
            formats: [{ type: "Formatted Text", url: "https://www.congress.gov/bill.htm" }],
          }],
        }),
        { status: 200 },
      ),
    );
  let sawAuthHeader = false;
  const rawFetchFn: RawFetchFn = (_url, init) => {
    sawAuthHeader = Object.prototype.hasOwnProperty.call(init, "headers");
    return Promise.resolve(new Response("<p>Text</p>", { status: 200 }));
  };
  const client = new CongressClient({ apiKey: "secret-key", timeoutMs: 1000, fetchFn, rawFetchFn });
  await client.getBillText({ congress: 119, type: "hr", number: 1234 });
  assertEquals(sawAuthHeader, false);
});

Deno.test("getBillText throws when no text versions are available", async () => {
  const fetchFn: FetchFn = () =>
    Promise.resolve(new Response(JSON.stringify({ textVersions: [] }), { status: 200 }));
  const client = new CongressClient({ apiKey: "k", timeoutMs: 1000, fetchFn });
  let caught: unknown;
  try {
    await client.getBillText({ congress: 119, type: "hr", number: 1234 });
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof CongressApiError)) throw new Error("expected CongressApiError");
});

Deno.test("getBillDetail distinguishes failed, partial, and empty collections", async () => {
  let fail = true;
  const client = new CongressClient({
    apiKey: "k",
    timeoutMs: 1000,
    fetchFn: (url) => {
      if (url.pathname.endsWith("/actions")) {
        return Promise.resolve(
          fail
            ? new Response("failure", { status: 503 })
            : Response.json({ actions: [], pagination: { count: 0 } }),
        );
      }
      if (url.pathname.endsWith("/subjects")) {
        return Promise.resolve(Response.json({
          subjects: { legislativeSubjects: [{ name: "Health" }] },
          pagination: { count: 2, next: "next page" },
        }));
      }
      return Promise.resolve(Response.json({ bill: summaryFixture }));
    },
  });
  const ref = { congress: 119, type: "hr", number: 1 };
  assertEquals((await client.getBillDetail(ref)).completeness, {
    actions: "unavailable",
    subjects: "partial",
  });
  fail = false;
  assertEquals((await client.getBillDetail(ref)).completeness?.actions, "complete");
  const controller = new AbortController();
  controller.abort();
  await assertRejects(() => client.getBillDetail(ref, controller.signal));
});

Deno.test("getBillText preserves original length and truncation metadata", async () => {
  const client = new CongressClient({
    apiKey: "k",
    timeoutMs: 1000,
    fetchFn: () =>
      Promise.resolve(Response.json({
        textVersions: [{
          type: "Introduced",
          formats: [{ type: "Formatted Text", url: "https://example.test/text" }],
        }],
      })),
    rawFetchFn: () => Promise.resolve(new Response("x".repeat(400_001))),
  });
  const text = await client.getBillText({ congress: 119, type: "hr", number: 1 });
  assertEquals(text.text.length, 400_000);
  assertEquals(text.originalLength, 400_001);
  assertEquals(text.truncated, true);
});

Deno.test("search coverage supports continuation and applies type filters to sponsor matches", async () => {
  const client = new CongressClient({
    apiKey: "k",
    timeoutMs: 1000,
    fetchFn: (url) => {
      if (url.pathname.includes("/bill/")) {
        const offset = Number(url.searchParams.get("offset"));
        return Promise.resolve(Response.json({
          bills: [{ ...summaryFixture, number: offset + 1 }],
          pagination: { count: 1501 },
        }));
      }
      if (url.pathname === "/v3/member/congress/118") {
        assertEquals(url.searchParams.has("currentMember"), false);
        return Promise.resolve(Response.json({ members: [{ bioguideId: "M1", name: "Example" }] }));
      }
      return Promise.resolve(
        Response.json({ sponsoredLegislation: [{ ...summaryFixture, congress: 118, type: "S" }] }),
      );
    },
  });
  const first = await client.searchBillsWithCoverage("example", undefined, {
    congress: 118,
    type: "hr",
  });
  assertEquals(first.nextOffset, 1500);
  assertEquals(first.bills.length, 6);
  assertEquals(first.bills.every((bill) => bill.type === "hr"), true);
  const next = await client.searchBillsWithCoverage("example", undefined, {
    congress: 118,
    offset: first.nextOffset,
  });
  assertEquals(next.nextOffset, undefined);
  assertEquals(next.bills[0].number, 1501);
});

Deno.test("member and sponsored legislation lookup paginate beyond old limits", async () => {
  const client = new CongressClient({
    apiKey: "k",
    timeoutMs: 1000,
    fetchFn: (url) => {
      const offset = Number(url.searchParams.get("offset"));
      if (url.pathname.includes("sponsored-legislation")) {
        return Promise.resolve(Response.json({
          sponsoredLegislation: [{ ...summaryFixture, congress: offset === 0 ? 119 : 118 }],
          pagination: { count: 251 },
        }));
      }
      return Promise.resolve(Response.json({
        members: [{ bioguideId: `M${offset}`, name: offset === 500 ? "Target Member" : "Other" }],
        pagination: { count: 501 },
      }));
    },
  });
  assertEquals((await client.searchMembers("target", undefined, 118))[0].bioguideId, "M500");
  assertEquals((await client.getSponsoredLegislation("M500", 118)).length, 1);
});

Deno.test("search reports unavailable sponsor coverage and propagates cancellation", async () => {
  const controller = new AbortController();
  const client = new CongressClient({
    apiKey: "k",
    timeoutMs: 1000,
    fetchFn: (url) => {
      if (url.pathname.includes("/member/")) {
        return Promise.resolve(new Response("failure", { status: 503 }));
      }
      return Promise.resolve(Response.json({ bills: [] }));
    },
  });
  const result = await client.searchBillsWithCoverage("example");
  assertEquals(result.limitations.length, 1);
  controller.abort();
  await assertRejects(() => client.searchBillsWithCoverage("example", controller.signal));
});
