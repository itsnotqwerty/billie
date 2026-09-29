import { assertEquals, assertStringIncludes } from "@std/assert";
import { ResearchStore, type SearchDefinition } from "../research/store.ts";
import { SavedSearchView } from "./saved_searches.ts";

const definition: SearchDefinition = {
  name: "Health",
  query: "health act",
  type: "hr",
  congress: { mode: "fixed", congress: 118 },
};

async function withStore(test: (store: ResearchStore) => void) {
  const directory = await Deno.makeTempDir();
  const store = await ResearchStore.open(`${directory}/billie/research.sqlite3`);
  try {
    test(store);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
}

function press(view: SavedSearchView, value: string): void {
  for (const char of value) view.handle({ kind: "char", value: char });
}

Deno.test("saved search view saves only explicitly and replays the latest persisted definition", async () => {
  await withStore((store) => {
    const view = new SavedSearchView(store, definition);
    assertEquals(store.listSearches().items.length, 0);
    press(view, "cw");
    const saved = store.listSearches().items[0];
    assertEquals(saved.congress, { mode: "current" });
    const edited = store.updateSearch(saved.id, saved.revision, {
      ...definition,
      query: "new query",
    });
    assertEquals(view.handle({ kind: "enter" }), { kind: "run", search: edited });
  });
});

Deno.test("saved search view duplicates, filters, and confirms deletion", async () => {
  await withStore((store) => {
    const saved = store.createSearch(definition);
    const view = new SavedSearchView(store);
    press(view, "uw");
    assertEquals(store.listSearches().items.length, 2);
    press(view, "/(copy)");
    view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "Health (copy)");
    press(view, "xn");
    assertEquals(store.listSearches().items.length, 2);
    press(view, "xy");
    assertEquals(store.listSearches().items.length, 1);
    assertEquals(store.getSearch(saved.id), saved);
  });
});

Deno.test("saved search view retains a conflicting draft and confirms discard", async () => {
  await withStore((store) => {
    const saved = store.createSearch(definition);
    const view = new SavedSearchView(store);
    press(view, "encustom");
    view.handle({ kind: "enter" });
    store.updateSearch(saved.id, saved.revision, { ...definition, name: "Other edit" });
    press(view, "w");
    assertStringIncludes(view.lines(30).join("\n"), "Healthcustom");
    assertStringIncludes(view.lines(30).join("\n"), "Reload before saving");
    view.handle({ kind: "escape" });
    press(view, "n");
    assertStringIncludes(view.lines(30).join("\n"), "Healthcustom");
    view.handle({ kind: "escape" });
    press(view, "yr");
    assertStringIncludes(view.lines(30).join("\n"), "Other edit");
  });
});

Deno.test("saved search view pages beyond fifty definitions and handles empty filters", async () => {
  await withStore((store) => {
    for (let index = 0; index < 55; index++) {
      store.createSearch({ ...definition, name: `Search ${index}` });
    }
    const view = new SavedSearchView(store);
    press(view, "l");
    assertStringIncludes(view.lines(30).join("\n"), "Page 2");
    press(view, "b");
    assertStringIncludes(view.lines(30).join("\n"), "Page 1");
    press(view, "/no matches");
    view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "No saved searches");
    assertEquals(view.handle({ kind: "enter" }), undefined);
  });
});

Deno.test("saved search view creates and edits definitions with validated fixed Congress", async () => {
  await withStore((store) => {
    const view = new SavedSearchView(store);
    press(view, "nnCustom");
    view.handle({ kind: "enter" });
    press(view, "qhealth");
    view.handle({ kind: "enter" });
    press(view, "tg");
    for (let index = 0; index < 10; index++) view.handle({ kind: "backspace" });
    press(view, "0");
    view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "positive integer");
    view.handle({ kind: "backspace" });
    press(view, "118");
    view.handle({ kind: "enter" });
    press(view, "w");
    const saved = store.listSearches().items[0];
    assertEquals(saved.name, "Custom");
    assertEquals(saved.query, "health");
    assertEquals(saved.type, "hr");
    assertEquals(saved.congress, { mode: "fixed", congress: 118 });
    press(view, "eq care");
    view.handle({ kind: "enter" });
    press(view, "w");
    assertEquals(store.getSearch(saved.id)?.query, "health care");
    assertEquals(store.getSearch(saved.id)?.revision, 2);
  });
});

Deno.test("saved search view keeps unsaved content after a storage write fails", async () => {
  await withStore((store) => {
    const view = new SavedSearchView({
      createSearch: () => {
        throw new Error("Disk full");
      },
      getSearch: store.getSearch.bind(store),
      listSearches: store.listSearches.bind(store),
      updateSearch: store.updateSearch.bind(store),
      deleteSearch: store.deleteSearch.bind(store),
    }, definition);
    press(view, "w");
    assertStringIncludes(view.lines(30).join("\n"), "Disk full");
    assertStringIncludes(view.lines(30).join("\n"), "health act");
    assertEquals(store.listSearches().items.length, 0);
  });
});
