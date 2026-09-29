import { assertEquals, assertStringIncludes } from "@std/assert";
import { App, type AppDependencies } from "./app.ts";
import type { Key } from "./terminal.ts";
import { type AppConfig, loadConfig } from "../config.ts";
import type { BillDetail, BillSummary } from "../types.ts";
import { ResearchStore } from "../research/store.ts";
import { NoteDrafts } from "../research/editor.ts";
import { currentCongress, type SearchOptions } from "../api/congress.ts";

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
  dependencies: Pick<
    AppDependencies,
    "research" | "researchError" | "editor" | "drafts" | "provider"
  > = {},
): Promise<void> {
  let screen = "";
  const config = await loadConfig({ get: () => undefined });
  await new App({ ...config, ...overrides }, {
    ...dependencies,
    client,
    terminal: {
      enter() {},
      exit() {},
      handoff: (operation) => operation(),
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

Deno.test("App explicitly refreshes notebook metadata without fetching on open", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Metadata");
    research.addReferences(notebook.id, [bill]);
    let calls = 0;
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        assertEquals(calls, 0);
        yield* type("f");
        await settle();
        assertStringIncludes(screen(), "Fixture bill");
        assertStringIncludes(screen(), "Retrieved:");
        yield* type("f");
        await settle();
        assertStringIncludes(screen(), "stale");
        assertStringIncludes(screen(), "Fixture bill");
      },
      {
        ...fakeClient(() => Promise.resolve([])),
        getBillDetail: () => {
          if (calls++) return Promise.reject(new Error("Unavailable"));
          return Promise.resolve({ ...bill, url: "https://api.congress.gov/v3/bill/119/hr/1" });
        },
      },
      {},
      { research },
    );
  });
});

Deno.test("App notes use the shared export menu and preserve reading position on return", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Exports");
    const note = research.createNote(notebook.id, {
      title: "Long note",
      body: Array.from({ length: 70 }, (_, index) => `Body line ${index}`).join("\n"),
    });
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("nw");
        assertStringIncludes(screen(), "File type: MARKDOWN");
        assertStringIncludes(screen(), "Text style: formatted");
        assertStringIncludes(screen(), "Scope: entire document");
        assertStringIncludes(screen(), "Directory: /tmp/billie-test-exports");
        yield { kind: "right" };
        yield { kind: "right" };
        assertStringIncludes(screen(), "File type: JSON");
        yield { kind: "down" };
        yield { kind: "right" };
        assertStringIncludes(screen(), "Text style: plain");
        yield { kind: "down" };
        yield { kind: "right" };
        assertStringIncludes(screen(), "Scope: current view");
        yield* type("d");
        assertStringIncludes(screen(), "Export directory");
        yield { kind: "escape" };
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Notes");
        yield { kind: "enter" };
        yield { kind: "pagedown" };
        assertStringIncludes(screen(), "Body line 10");
        const before = screen().split("Body line 10")[1].split("\n\n")[0];
        yield* type("w");
        assertStringIncludes(screen(), "File type: JSON");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Body line 10");
        assertStringIncludes(screen(), before);
        assertEquals(research.getNote(note.id), note);
      },
      undefined,
      { exportDir: "/tmp/billie-test-exports" },
      { research },
    );
  });
});

Deno.test("App generates prompt-only AI notes and saves Markdown without launching micro", async () => {
  for (const editFirst of [false, true]) {
    await withResearch(async (research) => {
      const directory = await Deno.makeTempDir();
      try {
        const notebook = research.createNotebook("AI notes");
        research.createNote(notebook.id, { title: "Private", body: "Do not send this" });
        const drafts = new NoteDrafts(`${directory}/drafts`);
        const created = deferred<void>();
        const create = drafts.create.bind(drafts);
        drafts.create = async (input) => {
          const result = await create(input);
          created.resolve();
          return result;
        };
        await exercise(
          async function* (screen) {
            yield* type("u");
            yield { kind: "enter" };
            yield* type("naDraft policy questions");
            assertStringIncludes(screen(), "Destination: http://localhost:11434/v1");
            assertStringIncludes(screen(), "Sends only this prompt");
            yield { kind: "enter" };
            await created.promise;
            await settle();
            assertStringIncludes(screen(), "AI draft ready");
            assertEquals(research.countNotes(notebook.id), 1);
            yield* type("W");
            assertStringIncludes(screen(), "File type: MARKDOWN");
            yield { kind: "escape" };
            assertStringIncludes(screen(), "Unsaved draft");
            assertEquals(research.countNotes(notebook.id), 1);
            if (editFirst) {
              yield* type("e");
              assertStringIncludes(screen(), "# Revised questions");
              assertEquals(research.countNotes(notebook.id), 1);
            }
            yield* type("w");
            assertEquals(research.countNotes(notebook.id), 2);
            assertStringIncludes(screen(), "Markdown:");
            const files = [];
            for await (const entry of Deno.readDir(`${directory}/exports`)) files.push(entry.name);
            assertEquals(files.length, 1);
            const body = await Deno.readTextFile(`${directory}/exports/${files[0]}`);
            assertStringIncludes(body, editFirst ? "# Revised questions" : "AI-generated draft");
            assertStringIncludes(body, editFirst ? "Human revision" : "# Questions");
          },
          undefined,
          { aiBaseUrl: "http://localhost:11434/v1", exportDir: `${directory}/exports` },
          {
            research,
            drafts,
            editor: {
              check: () => {
                if (!editFirst) throw new Error("Must not launch micro");
                return Promise.resolve();
              },
              edit: (filePath) =>
                Deno.writeTextFile(filePath, "# Revised questions\nHuman revision\n"),
            },
            provider: {
              model: "test-model",
              analyze: () => {
                throw new Error("Must not fetch or analyze source records");
              },
              analyzeComparison: () => {
                throw new Error("Must not analyze comparisons");
              },
              generateNote: (prompt) => {
                assertEquals(prompt, "Draft policy questions");
                return Promise.resolve("# Questions\n\n- Who benefits?\n");
              },
            },
          },
        );
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });
  }
});

Deno.test("App notes remain available with invalid AI configuration", async () => {
  await withResearch(async (research) => {
    research.createNotebook("Offline");
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("naQuestions");
        assertStringIncludes(screen(), "Invalid AI endpoint");
        yield { kind: "enter" };
        assertStringIncludes(screen(), "No AI provider configured");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Notes");
      },
      undefined,
      { aiApiKey: undefined, aiBaseUrl: "invalid endpoint" },
      { research },
    );
  });
});

Deno.test("App AI note cancellation ignores a late response and allows retry", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Cancel AI");
    const request = deferred<string>();
    let signal: AbortSignal | undefined;
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("naQuestions");
        yield { kind: "enter" };
        await settle();
        yield { kind: "escape" };
        assertEquals(signal!.aborted, true);
        request.resolve("Late response");
        await settle();
        assertStringIncludes(screen(), "Generation cancelled");
        assertEquals(screen().includes("Late response"), false);
        assertEquals(research.countNotes(notebook.id), 0);
        yield { kind: "enter" };
        await settle();
        assertStringIncludes(screen(), "Provider unavailable");
        assertStringIncludes(screen(), "Questions");
      },
      undefined,
      {},
      {
        research,
        provider: {
          model: "test",
          analyze: () => {
            throw new Error("Unused");
          },
          analyzeComparison: () => {
            throw new Error("Unused");
          },
          generateNote: (_prompt, abort) => {
            if (signal) return Promise.reject(new Error("Provider unavailable"));
            signal = abort;
            return request.promise;
          },
        },
      },
    );
  });
});

Deno.test("App awaits micro handoff, suppresses repaint, and saves only on confirmation", async () => {
  await withResearch(async (research) => {
    const directory = await Deno.makeTempDir();
    try {
      const notebook = research.createNotebook("Editor");
      const drafts = new NoteDrafts(`${directory}/drafts`);
      let editing = false;
      let screen = "";
      const events: string[] = [];
      const config = await loadConfig({ get: () => undefined });
      const app = new App(config, {
        research,
        drafts,
        editor: {
          check: () => {
            events.push("check");
            return Promise.resolve();
          },
          edit: async (filePath) => {
            events.push("edit");
            app.render();
            await Deno.writeTextFile(filePath, "# Edited in micro\n");
          },
        },
        terminal: {
          enter() {},
          exit() {},
          size: () => ({ columns: 120, rows: 40 }),
          render: (lines) => {
            assertEquals(editing, false);
            screen = lines.join("\n");
          },
          handoff: async (operation) => {
            events.push("suspend");
            editing = true;
            try {
              await operation();
            } finally {
              editing = false;
              events.push("restore");
            }
          },
          keys: async function* () {
            yield* type("u");
            yield { kind: "enter" };
            yield* type("nnFindings");
            yield { kind: "enter" };
            assertEquals(events, ["check", "suspend", "edit", "restore"]);
            assertStringIncludes(screen, "Unsaved draft: Findings");
            assertEquals(research.countNotes(notebook.id), 0);
            yield* type("w");
            assertEquals(research.countNotes(notebook.id), 1);
            assertEquals(
              research.getNote(research.listNotes(notebook.id).items[0].id)!.body,
              "# Edited in micro\n",
            );
            yield { kind: "escape" };
            assertStringIncludes(screen, "Notebook: Editor");
          },
        },
      });
      await app.run();
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});

Deno.test("App missing editor keeps private draft available for restart recovery", async () => {
  await withResearch(async (research) => {
    const directory = await Deno.makeTempDir();
    try {
      const notebook = research.createNotebook("Recovery");
      const drafts = new NoteDrafts(`${directory}/drafts`);
      await exercise(
        async function* (screen) {
          yield* type("u");
          yield { kind: "enter" };
          yield* type("nnDraft title");
          yield { kind: "enter" };
          assertStringIncludes(screen(), "Install micro");
          assertStringIncludes(screen(), "Recovery:");
          yield { kind: "ctrl", value: "c" };
        },
        undefined,
        {},
        {
          research,
          drafts,
          editor: {
            check: () => Promise.reject(new Error("Install micro")),
            edit: () => {
              throw new Error("Must not launch");
            },
          },
        },
      );
      assertEquals(research.countNotes(notebook.id), 0);
      assertEquals((await drafts.latest(notebook.id))!.title, "Draft title");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});

Deno.test("App manages note citations offline and returns to note and notebook without changing membership", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Citations");
    research.addReferences(notebook.id, [bill, { ...bill, number: 2 }, { ...bill, congress: 118 }]);
    const note = research.createNote(notebook.id, {
      title: "Offline note",
      body: "Local research",
    });
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("n");
        yield { kind: "enter" };
        assertStringIncludes(screen(), "Local research");
        yield* type("ca");
        for (let index = 0; index < 3; index++) {
          yield { kind: "enter" };
          yield* type("j");
        }
        assertStringIncludes(screen(), "3 cited");
        yield { kind: "escape" };
        yield* type("xn");
        assertEquals(research.countCitations(note.id), 3);
        yield* type("xy");
        assertEquals(research.countCitations(note.id), 2);
        yield { kind: "escape" };
        assertStringIncludes(screen(), "2 citations");
        assertStringIncludes(screen(), "Local research");
        yield { kind: "escape" };
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Notebook: Citations");
        assertEquals(research.countReferences(notebook.id), 3);
        assertEquals(research.getNote(note.id)!.body, "Local research");
      },
      undefined,
      { congressApiKey: undefined },
      { research },
    );
  });
});

Deno.test("App searches from an empty notebook and adds multiple references directly", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Search references");
    const note = research.createNote(notebook.id, { title: "Existing note", body: "Keep" });
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        assertStringIncludes(screen(), "s search and add");
        yield* type("shealth");
        assertStringIncludes(screen(), "Search legislation to add");
        yield { kind: "enter" };
        await settle();
        assertStringIncludes(screen(), "b add selected to notebook");
        assertEquals(research.countReferences(notebook.id), 0);
        yield* type("bb");
        assertStringIncludes(screen(), "already present");
        yield* type("jbjb");
        assertEquals(research.countReferences(notebook.id), 3);
        assertEquals(research.countCitations(note.id), 0);
        assertEquals(research.getNote(note.id)!.body, "Keep");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Notebook: Search references (3 references)");
      },
      fakeClient(() => Promise.resolve([bill, { ...bill, number: 2 }, { ...bill, number: 3 }])),
      {},
      { research },
    );
  });
});

Deno.test("App notebook search restores filtered pages and adds from details without replacing its target", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Paged notebook");
    research.addReferences(
      notebook.id,
      Array.from({ length: 60 }, (_, index) => ({ ...bill, number: index + 10 })),
    );
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("/119 hr");
        yield { kind: "enter" };
        yield* type("lj");
        const before = screen();
        yield* type("s");
        yield { kind: "escape" };
        assertEquals(screen(), before);
        yield* type("shealth");
        yield { kind: "enter" };
        await settle();
        yield { kind: "enter" };
        await settle();
        assertStringIncludes(screen(), "b add this legislation to notebook");
        yield* type("b");
        assertEquals(research.countReferences(notebook.id), 61);
        yield { kind: "escape" };
        yield* type("sother");
        yield { kind: "enter" };
        await settle();
        yield* type("b");
        assertStringIncludes(screen(), "already present");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Notebook: Paged notebook (61 references)");
        assertStringIncludes(screen(), "Page 2");
        assertStringIncludes(screen(), "Filter: 119 hr");
      },
      fakeClient(() => Promise.resolve([bill])),
      {},
      { research },
    );
  });
});

Deno.test("App notebook search cancels late results and clears the target on reset", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Cancellation");
    const request = deferred<BillSummary[]>();
    let signal: AbortSignal | undefined;
    let calls = 0;
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("shealth");
        yield { kind: "enter" };
        yield { kind: "escape" };
        assertEquals(signal!.aborted, true);
        yield { kind: "escape" };
        request.resolve([bill]);
        await settle();
        assertStringIncludes(screen(), "Notebook: Cancellation (0 references)");
        yield* type("shealth");
        yield { kind: "enter" };
        await settle();
        yield* type("dshealth");
        yield { kind: "enter" };
        await settle();
        assertStringIncludes(screen(), "c compare");
        yield* type("b");
        assertStringIncludes(screen(), "Enter chooses a notebook");
        assertEquals(research.countReferences(notebook.id), 0);
      },
      fakeClient((_query, requestSignal) => {
        signal = requestSignal;
        return calls++ === 0 ? request.promise : Promise.resolve([bill]);
      }),
      {},
      { research },
    );
  });
});

Deno.test("App notebook search handles missing credentials, failed additions, and deleted targets", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Failures");
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("shealth");
        yield { kind: "enter" };
        assertStringIncludes(screen(), "No Congress.gov API key configured");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Notebook: Failures");
      },
      undefined,
      { congressApiKey: undefined },
      { research },
    );
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("shealth");
        yield { kind: "enter" };
        await settle();
        const add = research.addReferences.bind(research);
        research.addReferences = () => {
          throw new Error("Disk full");
        };
        yield* type("b");
        assertStringIncludes(screen(), "Disk full");
        assertEquals(research.countReferences(notebook.id), 0);
        research.addReferences = add;
        yield* type("b");
        assertEquals(research.countReferences(notebook.id), 1);
        research.deleteNotebook(notebook.id, research.getNotebook(notebook.id)!.revision);
        yield* type("b");
        assertStringIncludes(screen(), "changed or was deleted");
        assertEquals(research.getNotebook(notebook.id), null);
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Notebook was deleted");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Notebooks");
      },
      fakeClient(() => Promise.resolve([bill])),
      {},
      { research },
    );
  });
});

Deno.test("App notebook selections carry across pages into a note's citation picker", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Selected sources");
    research.addReferences(
      notebook.id,
      Array.from({ length: 55 }, (_, index) => ({ ...bill, number: index + 1 })),
    );
    const note = research.createNote(notebook.id, { title: "Research", body: "Keep" });
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type(" j j l ");
        assertStringIncludes(screen(), "select (4)");
        yield* type("n");
        assertStringIncludes(screen(), "4 notebook references selected");
        yield* type("c");
        assertStringIncludes(screen(), "Add citations: Research");
        assertStringIncludes(screen(), "4 selected");
        assertEquals(research.countCitations(note.id), 0);
        yield { kind: "enter" };
        assertEquals(research.countCitations(note.id), 4);
        assertEquals(research.getNote(note.id)!.body, "Keep");
        assertEquals(research.countReferences(notebook.id), 55);
      },
      undefined,
      { congressApiKey: undefined },
      { research },
    );
  });
});

Deno.test("App research search multiselect spans queries, toggles, and retains failed writes for retry", async () => {
  for (const citing of [false, true]) {
    await withResearch(async (research) => {
      const notebook = research.createNotebook("Selections");
      const note = research.createNote(notebook.id, { title: "Sources", body: "Keep" });
      const add = research.addReferences.bind(research);
      const cite = research.citeReference.bind(research);
      let calls = 0;
      research.addReferences = (id, refs) => {
        if (++calls === 2) throw new Error("Disk full");
        return add(id, refs);
      };
      research.citeReference = (id, revision, ref) => {
        if (++calls === 2) throw new Error("Disk full");
        return cite(id, revision, ref);
      };
      await exercise(
        async function* (screen) {
          yield* type("u");
          yield { kind: "enter" };
          yield* type(citing ? "ncsfirst" : "sfirst");
          yield { kind: "enter" };
          await settle();
          yield* type(" j j ");
          assertStringIncludes(screen(), "3 selected");
          yield* type(" ");
          assertStringIncludes(screen(), "2 selected");
          yield* type(" ");
          assertEquals(research.countReferences(notebook.id), 0);
          yield* type("ssecond");
          yield { kind: "enter" };
          await settle();
          assertStringIncludes(screen(), "3 selected");
          yield* type(" ");
          assertStringIncludes(screen(), "4 selected");
          yield* type(citing ? "c" : "b");
          assertStringIncludes(screen(), "3 selected references remaining");
          assertEquals(research.countReferences(notebook.id), 1);
          yield* type(citing ? "c" : "b");
          assertEquals(research.countReferences(notebook.id), 4);
          assertEquals(research.countCitations(note.id), citing ? 4 : 0);
          assertEquals(research.getNote(note.id)!.body, "Keep");
          assertStringIncludes(screen(), "0 selected");
        },
        fakeClient((query) =>
          Promise.resolve(
            query === "first"
              ? [bill, { ...bill, number: 2 }, { ...bill, number: 3 }]
              : [{ ...bill, congress: 118, number: 4 }],
          )
        ),
        {},
        { research },
      );
    });
  }
});

Deno.test("App leaving contextual search clears multiselections without applying them", async () => {
  for (const citing of [false, true]) {
    await withResearch(async (research) => {
      const notebook = research.createNotebook("Cancel selections");
      const note = research.createNote(notebook.id, { title: "Sources", body: "Keep" });
      await exercise(
        async function* (screen) {
          yield* type("u");
          yield { kind: "enter" };
          yield* type(citing ? "ncsquery" : "squery");
          yield { kind: "enter" };
          await settle();
          yield* type(" j j ");
          assertStringIncludes(screen(), "3 selected");
          yield { kind: "escape" };
          assertEquals(research.countReferences(notebook.id), 0);
          assertEquals(research.countCitations(note.id), 0);
          yield* type("squery");
          yield { kind: "enter" };
          await settle();
          assertStringIncludes(screen(), "0 selected");
        },
        fakeClient(() => Promise.resolve([bill, { ...bill, number: 2 }, { ...bill, number: 3 }])),
        {},
        { research },
      );
    });
  }
});

Deno.test("App searches and cites multiple new sources directly from a saved note", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Search citations");
    const note = research.createNote(notebook.id, { title: "Find sources", body: "Keep text" });
    const queries: string[] = [];
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("ncshealth");
        yield { kind: "enter" };
        await settle();
        assertEquals(queries, ["health"]);
        assertStringIncludes(screen(), bill.title);
        assertStringIncludes(screen(), "c cite selected + add to notebook");
        assertEquals(research.countReferences(notebook.id), 0);
        yield* type("cc");
        assertStringIncludes(screen(), "already cited");
        yield* type("jcjc");
        assertEquals(research.countCitations(note.id), 3);
        assertEquals(research.countReferences(notebook.id), 3);
        assertEquals(research.getNote(note.id)!.body, "Keep text");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Citations: Find sources");
        assertStringIncludes(screen(), "3 cited");
      },
      fakeClient((query) => {
        queries.push(query);
        return Promise.resolve([bill, { ...bill, number: 2 }, { ...bill, number: 3 }]);
      }),
      {},
      { research },
    );
  });
});

Deno.test("App citation search cancels requests without leaving citations or accepting late results", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Cancel search");
    const note = research.createNote(notebook.id, { title: "Sources", body: "" });
    const request = deferred<BillSummary[]>();
    let signal: AbortSignal | undefined;
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("ncs");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Citations: Sources");
        yield* type("shealth");
        yield { kind: "enter" };
        assertStringIncludes(screen(), "Searching");
        yield { kind: "escape" };
        assertEquals(signal!.aborted, true);
        yield { kind: "escape" };
        request.resolve([bill]);
        await settle();
        assertStringIncludes(screen(), "Citations: Sources");
        assertEquals(research.countReferences(notebook.id), 0);
        assertEquals(research.countCitations(note.id), 0);
      },
      fakeClient((_query, requestSignal) => {
        signal = requestSignal;
        return request.promise;
      }),
      {},
      { research },
    );
  });
});

Deno.test("App citation search reports missing credentials and preserves the offline picker", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Offline");
    research.createNote(notebook.id, { title: "Offline sources", body: "" });
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("ncashealth");
        yield { kind: "enter" };
        assertStringIncludes(screen(), "No Congress.gov API key");
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Add citations: Offline sources");
        assertEquals(research.countReferences(notebook.id), 0);
      },
      undefined,
      { congressApiKey: undefined },
      { research },
    );
  });
});

Deno.test("App citation search preserves revision conflicts and supports retry after explicit reload", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Conflicts");
    const note = research.createNote(notebook.id, { title: "Sources", body: "Original" });
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield* type("ncshealth");
        yield { kind: "enter" };
        await settle();
        research.updateNote(note.id, note.revision, { title: "Sources", body: "Concurrent text" });
        yield* type("c");
        assertStringIncludes(screen(), "Reload before saving");
        assertEquals(research.countReferences(notebook.id), 0);
        yield { kind: "escape" };
        yield* type("rshealth");
        yield { kind: "enter" };
        await settle();
        yield { kind: "enter" };
        await settle();
        assertStringIncludes(screen(), "c cite this legislation");
        yield* type("c");
        assertEquals(research.countCitations(note.id), 1);
        assertEquals(research.getNote(note.id)!.body, "Concurrent text");
        yield { kind: "escape" };
        yield { kind: "escape" };
        assertStringIncludes(screen(), "1 cited");
      },
      fakeClient(() => Promise.resolve([bill])),
      {},
      { research },
    );
  });
});

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

async function withResearch(test: (research: ResearchStore) => Promise<void>) {
  const directory = await Deno.makeTempDir();
  const research = await ResearchStore.open(`${directory}/billie/research.sqlite3`);
  try {
    await test(research);
  } finally {
    research.close();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("App adds loaded results without compare marks and restores notebook position from detail", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Legislation");
    const bills = Array.from({ length: 55 }, (_, index) => ({ ...bill, number: index + 1 }));
    let detailCalls = 0;
    const client = {
      ...fakeClient(() => Promise.resolve(bills)),
      getBillDetail: (ref: BillSummary | { congress: number; type: string; number: number }) => {
        detailCalls++;
        return Promise.resolve({ ...bill, ...ref });
      },
    };
    await exercise(
      async function* (screen) {
        yield* type("sfixture");
        yield { kind: "enter" };
        await settle();
        yield* type("B");
        yield { kind: "enter" };
        await new Promise((resolve) => setTimeout(resolve, 10));
        assertEquals(research.countReferences(notebook.id), 55);
        assertEquals(detailCalls, 0);
        yield* type("ljj");
        const before = screen();
        yield { kind: "enter" };
        await settle();
        assertEquals(detailCalls, 1);
        yield { kind: "escape" };
        assertEquals(
          screen().split("\n").filter((line) => line.startsWith("  >")),
          before.split("\n").filter((line) => line.startsWith("  >")),
        );
        assertStringIncludes(screen(), "Page 2");
        yield* type("mjm");
        yield* type("c");
        await settle();
        assertEquals(detailCalls, 3);
        yield { kind: "escape" };
        assertStringIncludes(screen(), "Page 2");
        assertEquals(research.countReferences(notebook.id), 55);
        yield { kind: "escape" };
        yield { kind: "escape" };
        yield* type("d");
        assertEquals(research.countReferences(notebook.id), 55);
      },
      client,
      {},
      { research },
    );
  });
});

Deno.test("App notebook library works offline and rejects late detail responses", async () => {
  await withResearch(async (research) => {
    const notebook = research.createNotebook("Offline");
    research.addReferences(notebook.id, [bill]);
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield { kind: "enter" };
        assertStringIncludes(screen(), "available offline");
      },
      undefined,
      { congressApiKey: undefined },
      { research },
    );
    const request = deferred<BillDetail>();
    await exercise(
      async function* (screen) {
        yield* type("u");
        yield { kind: "enter" };
        yield { kind: "enter" };
        yield { kind: "escape" };
        request.resolve(bill);
        await settle();
        assertStringIncludes(screen(), "Notebooks");
        assertEquals(screen().includes(bill.title), false);
      },
      { ...fakeClient(() => Promise.resolve([])), getBillDetail: () => request.promise },
      {},
      { research },
    );
  });
});

Deno.test("App saves an empty-result query and replays its filters from offset zero", async () => {
  await withResearch(async (research) => {
    const calls: Array<{ query: string; options?: SearchOptions }> = [];
    await exercise(
      async function* (screen) {
        yield* type("shealth");
        yield { kind: "enter" };
        await settle();
        yield* type("t");
        await settle();
        yield* type("<");
        await settle();
        yield* type("p");
        assertStringIncludes(screen(), "New saved search");
        assertEquals(research.listSearches().items.length, 0);
        yield* type("w");
        assertEquals(research.listSearches().items[0].type, "hr");
        yield { kind: "enter" };
        await settle();
        assertStringIncludes(screen(), "No matching bills");
        assertStringIncludes(screen(), "Partial title coverage");
        assertEquals(calls.at(-1), {
          query: "health",
          options: { congress: currentCongress() - 1, type: "hr", offset: 0 },
        });
        yield* type("d");
        assertEquals(research.listSearches().items.length, 1);
      },
      {
        ...fakeClient(() => Promise.resolve([])),
        searchBillsWithCoverage: (query, _signal, options) => {
          calls.push({ query, options });
          return Promise.resolve({ bills: [], scanned: 1500, nextOffset: 1500, limitations: [] });
        },
      },
      {},
      { research },
    );
  });
});

Deno.test("App resolves dynamic Congress at replay without rewriting the definition", async () => {
  await withResearch(async (research) => {
    const saved = research.createSearch({
      name: "Current",
      query: "science",
      type: "s",
      congress: { mode: "current" },
    });
    let options: SearchOptions | undefined;
    await exercise(
      async function* (screen) {
        yield* type("o");
        yield { kind: "enter" };
        await settle();
        assertStringIncludes(screen(), `${currentCongress()}th Congress`);
        assertEquals(options, { congress: currentCongress(), type: "s", offset: 0 });
        assertEquals(research.getSearch(saved.id), saved);
      },
      {
        ...fakeClient(() => Promise.resolve([])),
        searchBillsWithCoverage: (_query, _signal, selection) => {
          options = selection;
          return Promise.resolve({ bills: [], scanned: 0, limitations: [] });
        },
      },
      {},
      { research },
    );
  });
});

Deno.test("App supports offline saved-search management and recoverable storage errors", async () => {
  await withResearch(async (research) => {
    research.createSearch({
      name: "Offline",
      query: "health",
      type: null,
      congress: { mode: "fixed", congress: 118 },
    });
    await exercise(
      async function* (screen) {
        yield* type("o");
        assertStringIncludes(screen(), "Offline");
        yield { kind: "enter" };
        assertStringIncludes(screen(), "API key is required");
        yield* type("uw");
        assertEquals(research.listSearches().items.length, 2);
      },
      undefined,
      {},
      { research },
    );
  });
  await exercise(
    async function* (screen) {
      yield* type("o");
      assertStringIncludes(screen(), "Saved searches unavailable: database locked");
      yield* type("shealth");
      yield { kind: "enter" };
      await settle();
      assertStringIncludes(screen(), bill.title);
    },
    fakeClient(() => Promise.resolve([bill])),
    {},
    { researchError: "database locked" },
  );
});

Deno.test("App ignores late search results after opening the saved-search library", async () => {
  await withResearch(async (research) => {
    const pending = deferred<BillSummary[]>();
    await exercise(
      async function* (screen) {
        yield* type("shealth");
        yield { kind: "enter" };
        yield* type("o");
        pending.resolve([bill]);
        await settle();
        assertStringIncludes(screen(), "Saved searches");
        assertEquals(screen().includes(bill.title), false);
      },
      fakeClient(() => pending.promise),
      {},
      { research },
    );
  });
});

Deno.test("App cancels saved-search replay when editing begins", async () => {
  await withResearch(async (research) => {
    research.createSearch({
      name: "Health",
      query: "health",
      type: null,
      congress: { mode: "current" },
    });
    const pending = deferred<BillSummary[]>();
    let signal: AbortSignal | undefined;
    await exercise(
      async function* (screen) {
        yield* type("o");
        yield { kind: "enter" };
        yield* type("e");
        assertEquals(signal?.aborted, true);
        pending.resolve([bill]);
        await settle();
        assertStringIncludes(screen(), "Edit saved search");
        assertEquals(screen().includes(bill.title), false);
      },
      fakeClient((_query, requestSignal) => {
        signal = requestSignal;
        return pending.promise;
      }),
      {},
      { research },
    );
  });
});
