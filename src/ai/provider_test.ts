import {
  AiError,
  analysisPrompt,
  type ChatFetchFn,
  comparisonAnalysisPrompt,
  OpenAiCompatProvider,
  parseAnalysisJson,
} from "./provider.ts";
import type { BillDetail } from "../types.ts";
import { compareBills } from "../compare.ts";
import { assertEquals, assertThrows } from "@std/assert";

function makeBill(): BillDetail {
  return {
    congress: 119,
    type: "hr",
    number: 1234,
    title: "Wildfire Response and Drought Resiliency Act",
    updateDate: "2026-09-01",
    url: "https://api.congress.gov/v3/bill/119/hr/1234",
    sponsors: [{ name: "Smith, Alex" }],
    subjects: ["Emergency management"],
    actions: [{ date: "2026-01-15", text: "Introduced in House." }],
  };
}

const VALID_JSON = JSON.stringify({
  summary: "A bill about wildfire response.",
  keyProvisions: ["Provision one"],
  affectedParties: ["State agencies"],
  uncertainties: ["Fiscal impact not determinable from supplied data."],
});

Deno.test("parseAnalysisJson accepts a valid payload", () => {
  const result = parseAnalysisJson(VALID_JSON);
  assertEquals(result.summary, "A bill about wildfire response.");
  assertEquals(result.keyProvisions, ["Provision one"]);
});

Deno.test("parseAnalysisJson extracts JSON from surrounding prose", () => {
  const result = parseAnalysisJson(`Here is the analysis:\n${VALID_JSON}\nDone.`);
  assertEquals(result.keyProvisions, ["Provision one"]);
});

Deno.test("parseAnalysisJson rejects malformed and incomplete payloads", () => {
  assertThrows(() => parseAnalysisJson("no json here"), AiError);
  assertThrows(() => parseAnalysisJson("{not json}"), AiError);
  assertThrows(() => parseAnalysisJson('{"keyProvisions": []}'), AiError);
  assertThrows(() => parseAnalysisJson('{"summary": "x", "keyProvisions": [1]}'), AiError);
});

Deno.test("analysisPrompt includes record fields and verbatim bill text", () => {
  const prompt = analysisPrompt(makeBill(), {
    versionType: "Introduced",
    date: "2026-01-15",
    sourceUrl: "https://example.test/bill-text",
    text: "SECTION 1. Short title.\nThis is the complete text.",
  });
  if (
    !prompt.includes("HR 1234") || !prompt.includes("Emergency management") ||
    !prompt.includes("This is the complete text.")
  ) {
    throw new Error("prompt missing record fields");
  }
  assertEquals(prompt.includes("The complete available text is included."), true);
});

Deno.test("analysisPrompt explicitly identifies truncated bill text", () => {
  const prompt = analysisPrompt(makeBill(), {
    versionType: "Introduced",
    sourceUrl: "https://example.test/bill-text",
    text: "x".repeat(100_001),
  });
  assertEquals(prompt.includes("first 100000 characters"), true);
  assertEquals(prompt.includes("remainder was omitted"), true);
  assertEquals(prompt.length < 101_000, true);
});

Deno.test("comparisonAnalysisPrompt includes both records, differences, and question", () => {
  const billA = makeBill();
  const billB = {
    ...makeBill(),
    type: "s",
    number: 88,
    title: "Wildfire Recovery Act",
    policyArea: "Natural resources",
    actions: [{ date: "2026-02-01", text: "Passed Senate." }],
  };
  const prompt = comparisonAnalysisPrompt(
    compareBills(billA, billB),
    "How do their sponsors and actions differ?",
    {
      versionType: "Introduced",
      sourceUrl: "https://example.test/a",
      text: "Bill A section 1",
    },
    {
      versionType: "Engrossed",
      sourceUrl: "https://example.test/b",
      text: "Bill B section 1",
    },
  );
  assertEquals(prompt.includes("How do their sponsors and actions differ?"), true);
  assertEquals(prompt.includes("HR 1234"), true);
  assertEquals(prompt.includes("S 88"), true);
  assertEquals(prompt.includes("Policy area: A=unavailable; B=Natural resources"), true);
  assertEquals(prompt.includes("Bill A section 1"), true);
  assertEquals(prompt.includes("Bill B section 1"), true);
  assertEquals(prompt.includes("<bill_a_text>"), true);
  assertEquals(prompt.includes("<bill_b_text>"), true);
});

function providerWith(fetchFn: ChatFetchFn): OpenAiCompatProvider {
  return new OpenAiCompatProvider({
    apiKey: "sk-test",
    model: "test-model",
    baseUrl: "https://api.example.test/v1/",
    timeoutMs: 1000,
    fetchFn,
  });
}

Deno.test("OpenAiCompatProvider posts the prompt and parses the content", async () => {
  const seen: { url?: string; auth?: string; body?: string } = {};
  const provider = providerWith((url, init) => {
    seen.url = url.toString();
    seen.auth = init.headers.Authorization;
    seen.body = init.body;
    return Promise.resolve(
      new Response(
        JSON.stringify({ choices: [{ message: { content: VALID_JSON } }] }),
        { status: 200 },
      ),
    );
  });
  const result = await provider.analyze(makeBill(), {
    versionType: "Introduced",
    sourceUrl: "https://example.test/bill-text",
    text: "SEC. 1. Actual text sent to the model.",
  });
  assertEquals(result.summary, "A bill about wildfire response.");
  assertEquals(seen.url, "https://api.example.test/v1/chat/completions");
  assertEquals(seen.auth, "Bearer sk-test");
  if (
    !seen.body?.includes("test-model") || !seen.body.includes("HR 1234") ||
    !seen.body.includes("Actual text sent to the model.")
  ) {
    throw new Error("request body missing model or bill context");
  }
});

Deno.test("OpenAiCompatProvider sends comparison question and both bill contexts", async () => {
  const billA = makeBill();
  const billB = { ...makeBill(), type: "s", number: 88, title: "Wildfire Recovery Act" };
  const seen: { body?: string } = {};
  const provider = providerWith((_url, init) => {
    seen.body = init.body;
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: VALID_JSON } }] }), {
        status: 200,
      }),
    );
  });
  const result = await provider.analyzeComparison(
    compareBills(billA, billB),
    "Which actions differ?",
    { versionType: "Introduced", sourceUrl: "https://example.test/a", text: "Actual A text." },
    { versionType: "Engrossed", sourceUrl: "https://example.test/b", text: "Actual B text." },
  );
  assertEquals(result.summary, "A bill about wildfire response.");
  assertEquals(seen.body?.includes("Which actions differ?"), true);
  assertEquals(seen.body?.includes("HR 1234"), true);
  assertEquals(seen.body?.includes("S 88"), true);
  assertEquals(seen.body?.includes("Actual A text."), true);
  assertEquals(seen.body?.includes("Actual B text."), true);
});

Deno.test("OpenAiCompatProvider rejects responses without message content", async () => {
  const provider = providerWith(() =>
    Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
  );
  let caught: unknown;
  try {
    await provider.analyze(makeBill(), {
      versionType: "Introduced",
      sourceUrl: "https://example.test/bill-text",
      text: "Bill text",
    });
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof AiError)) throw new Error("expected AiError");
});

Deno.test("OpenAiCompatProvider surfaces HTTP errors", async () => {
  const provider = providerWith(() =>
    Promise.resolve(new Response("quota exceeded", { status: 429 }))
  );
  let caught: unknown;
  try {
    await provider.analyze(makeBill(), {
      versionType: "Introduced",
      sourceUrl: "https://example.test/bill-text",
      text: "Bill text",
    });
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof AiError)) throw new Error("expected AiError");
  assertEquals(caught.status, 429);
  assertEquals(caught.message, "AI provider error 429: quota exceeded");
});

Deno.test("OpenAiCompatProvider extracts provider error messages", async () => {
  const provider = providerWith(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            message: "The model `gpt-5.6-sol` does not exist.",
            type: "invalid_request_error",
          },
        }),
        { status: 400 },
      ),
    )
  );
  let caught: unknown;
  try {
    await provider.analyze(makeBill(), {
      versionType: "Introduced",
      sourceUrl: "https://example.test/bill-text",
      text: "Bill text",
    });
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof AiError)) throw new Error("expected AiError");
  assertEquals(caught.status, 400);
  assertEquals(
    caught.message,
    "AI provider error 400: The model `gpt-5.6-sol` does not exist.",
  );
});

Deno.test("OpenAiCompatProvider lists models from the endpoint, sorted", async () => {
  const seen: { url?: string; method?: string; auth?: string; body?: string } = {};
  const provider = providerWith((url, init) => {
    seen.url = url.toString();
    seen.method = init.method;
    seen.auth = init.headers.Authorization;
    seen.body = init.body;
    return Promise.resolve(
      new Response(
        JSON.stringify({ data: [{ id: "zeta-2" }, { id: "alpha-1" }, { id: "beta-9" }] }),
        { status: 200 },
      ),
    );
  });
  const models = await provider.listModels();
  assertEquals(models, ["alpha-1", "beta-9", "zeta-2"]);
  assertEquals(seen.url, "https://api.example.test/v1/models");
  assertEquals(seen.method, "GET");
  assertEquals(seen.auth, "Bearer sk-test");
  assertEquals(seen.body, undefined);
});

Deno.test("OpenAiCompatProvider omits the auth header for keyless endpoints", async () => {
  const seen: { auth?: string } = {};
  const provider = new OpenAiCompatProvider({
    apiKey: "",
    model: "unused",
    baseUrl: "http://localhost:1234/v1",
    timeoutMs: 1000,
    fetchFn: (_url, init) => {
      seen.auth = init.headers.Authorization;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "local-model" }] }), { status: 200 }),
      );
    },
  });
  const models = await provider.listModels();
  assertEquals(models, ["local-model"]);
  assertEquals(seen.auth, undefined);
});

Deno.test("OpenAiCompatProvider surfaces model-list HTTP errors with detail", async () => {
  const provider = providerWith(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    )
  );
  let caught: unknown;
  try {
    await provider.listModels();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof AiError)) throw new Error("expected AiError");
  assertEquals(caught.status, 401);
  assertEquals(caught.message, "AI provider error 401: bad key");
});
