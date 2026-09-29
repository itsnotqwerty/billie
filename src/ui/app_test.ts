import { assertEquals, assertStringIncludes } from "@std/assert";
import { App, type AppDependencies } from "./app.ts";
import type { Key } from "./terminal.ts";
import { type AppConfig, loadConfig } from "../config.ts";
import type { BillDetail, BillSummary } from "../types.ts";

const bill: BillDetail = {
  congress: 119,
  type: "hr",
  number: 1,
  title: "Fixture bill",
  updateDate: "2026-09-28",
  url: "https://example.test/bill",
  sponsors: [],
  subjects: [],
  actions: [],
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

function* type(value: string): Generator<Key> {
  for (const char of value) yield { kind: "char", value: char };
}

async function exercise(
  script: (screen: () => string) => AsyncGenerator<Key>,
  client: AppDependencies["client"],
  overrides: Partial<AppConfig> = {},
): Promise<void> {
  let screen = "";
  const config = await loadConfig({ get: () => undefined });
  await new App({ ...config, ...overrides }, {
    client,
    terminal: {
      enter() {},
      exit() {},
      size: () => ({ columns: 100, rows: 40 }),
      render: (lines) => screen = lines.join("\n"),
      keys: () => script(() => screen),
    },
  }).run();
}

function fakeClient(searchBills: (query: string, signal?: AbortSignal) => Promise<BillSummary[]>) {
  return {
    searchBillsWithCoverage: async (query: string, signal?: AbortSignal) => {
      const bills = await searchBills(query, signal);
      return { bills, scanned: bills.length, limitations: [] };
    },
    getBillDetail: () => Promise.resolve(bill),
    getBillText: () => Promise.reject(new Error("Text service unavailable")),
  };
}

Deno.test("App obsolete rejection cannot clear a newer search or disable cancellation", async () => {
  const requests: Array<ReturnType<typeof deferred<BillSummary[]>>> = [];
  const signals: AbortSignal[] = [];
  await exercise(
    async function* (screen) {
      yield* type("sfirst");
      yield { kind: "enter" };
      yield* type("ssecond");
      yield { kind: "enter" };
      requests[0].reject(new Error("Old request failed"));
      await settle();
      assertStringIncludes(screen(), "Searching “second”");
      yield { kind: "escape" };
      assertEquals(signals[1].aborted, true);
      requests[1].resolve([bill]);
      await settle();
      assertStringIncludes(screen(), "Cancelled.");
      assertEquals(screen().includes(bill.title), false);
    },
    fakeClient((_query, signal) => {
      const request = deferred<BillSummary[]>();
      requests.push(request);
      signals.push(signal!);
      return request.promise;
    }),
  );
});

Deno.test("App empty search replaces previous results", async () => {
  let calls = 0;
  await exercise(async function* (screen) {
    yield* type("sfirst");
    yield { kind: "enter" };
    await settle();
    assertStringIncludes(screen(), bill.title);
    yield* type("snone");
    yield { kind: "enter" };
    await settle();
    assertEquals(screen().includes(bill.title), false);
    assertStringIncludes(screen(), "No matching bills");
  }, fakeClient(() => Promise.resolve(calls++ === 0 ? [bill] : [])));
});

Deno.test("App reset aborts work and ignores late successful responses", async () => {
  const request = deferred<BillSummary[]>();
  let signal: AbortSignal | undefined;
  await exercise(
    async function* (screen) {
      yield* type("sfirst");
      yield { kind: "enter" };
      yield* type("d");
      assertEquals(signal?.aborted, true);
      request.resolve([bill]);
      await settle();
      assertStringIncludes(screen(), "Selection cleared.");
      assertEquals(screen().includes(bill.title), false);
    },
    fakeClient((_query, requestSignal) => {
      signal = requestSignal;
      return request.promise;
    }),
  );
});

Deno.test("App shows text retrieval errors and allows retry", async () => {
  let attempts = 0;
  const client = fakeClient(() => Promise.resolve([bill]));
  client.getBillText = () => {
    attempts++;
    return Promise.reject(new Error("Text service unavailable"));
  };
  await exercise(async function* (screen) {
    yield* type("sfirst");
    yield { kind: "enter" };
    await settle();
    yield { kind: "enter" };
    await settle();
    yield* type("x");
    await settle();
    assertStringIncludes(screen(), "Text unavailable: Text service unavailable");
    yield* type("xx");
    await settle();
    assertEquals(attempts, 2);
  }, client);
});

Deno.test("App masks credential input while leaving model input readable", async () => {
  await exercise(async function* (screen) {
    yield* type("ikFAKE-SECRET");
    assertEquals(screen().includes("FAKE-SECRET"), false);
    assertStringIncludes(screen(), "***********");
    yield { kind: "escape" };
    yield* type("cOTHER-SECRET");
    assertEquals(screen().includes("OTHER-SECRET"), false);
    yield { kind: "escape" };
    yield* type("m-model");
    assertStringIncludes(screen(), "-model");
  }, fakeClient(() => Promise.resolve([])));
});

Deno.test("App redacts configured secrets from provider diagnostics", async () => {
  await exercise(
    async function* (screen) {
      yield* type("stest");
      yield { kind: "enter" };
      await settle();
      assertStringIncludes(screen(), "Error: key=*** auth=***");
    },
    fakeClient(() => Promise.reject(new Error("key=congress-secret auth=ai-secret"))),
    {
      congressApiKey: "congress-secret",
      aiApiKey: "ai-secret",
    },
  );
});

Deno.test("App loads more search results without losing previous matches", async () => {
  const offsets: Array<number | undefined> = [];
  const client: AppDependencies["client"] = {
    ...fakeClient(() => Promise.resolve([])),
    searchBillsWithCoverage: (_query, _signal, options) => {
      offsets.push(options?.offset);
      const next = options?.offset === 1500;
      return Promise.resolve({
        bills: [next ? { ...bill, number: 2, title: "Later bill" } : bill],
        scanned: next ? 1 : 1500,
        nextOffset: next ? undefined : 1500,
        limitations: next ? [] : ["Sponsor lookup unavailable"],
      });
    },
  };
  await exercise(async function* (screen) {
    yield* type("sfixture");
    yield { kind: "enter" };
    await settle();
    assertStringIncludes(screen(), "Partial title coverage");
    yield* type("l");
    await settle();
    assertStringIncludes(screen(), bill.title);
    assertStringIncludes(screen(), "Later bill");
    assertStringIncludes(screen(), "1501 bill records scanned");
    assertStringIncludes(screen(), "Sponsor lookup unavailable");
    assertEquals(offsets, [0, 1500]);
  }, client);
});

Deno.test("App enables keyless local analysis with a mocked provider endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    assertEquals(new Headers(init?.headers).has("Authorization"), false);
    return Promise.resolve(Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "Local analysis result",
            keyProvisions: [],
            affectedParties: [],
            uncertainties: [],
          }),
        },
      }],
    }));
  };
  try {
    await exercise(async function* (screen) {
      yield* type("sfixture");
      yield { kind: "enter" };
      await settle();
      yield { kind: "enter" };
      await settle();
      yield* type("a");
      for (let turn = 0; turn < 8; turn++) await settle();
      assertStringIncludes(screen(), "Local analysis result");
    }, {
      ...fakeClient(() => Promise.resolve([bill])),
      getBillText: () =>
        Promise.resolve({ versionType: "Introduced", sourceUrl: bill.url, text: "Full text" }),
    }, { aiBaseUrl: "http://localhost:11434/v1", aiApiKey: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("App cancels background text retrieval on reset", async () => {
  const request = deferred<import("../types.ts").BillText>();
  let signal: AbortSignal | undefined;
  await exercise(async function* (screen) {
    yield* type("sfixture");
    yield { kind: "enter" };
    await settle();
    yield { kind: "enter" };
    await settle();
    yield* type("xd");
    assertEquals(signal?.aborted, true);
    request.resolve({ versionType: "Introduced", sourceUrl: bill.url, text: "Late text" });
    await settle();
    assertStringIncludes(screen(), "Selection cleared.");
  }, {
    ...fakeClient(() => Promise.resolve([bill])),
    getBillText: (_bill, requestSignal) => {
      signal = requestSignal;
      return request.promise;
    },
  });
});
