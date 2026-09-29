import { assertEquals, assertStringIncludes } from "@std/assert";
import { ResearchStore } from "../research/store.ts";
import { NotebookView } from "./notebooks.ts";

async function withStore(test: (store: ResearchStore) => void | Promise<void>) {
  const directory = await Deno.makeTempDir();
  const store = await ResearchStore.open(`${directory}/billie/research.sqlite3`);
  try {
    await test(store);
  } finally {
    store.close();
    await Deno.remove(directory, { recursive: true });
  }
}
function press(view: NotebookView, value: string): void {
  for (const char of value) view.handle({ kind: "char", value: char });
}

Deno.test("notebook UI creates, edits, adds offline references, and confirms removal", async () => {
  await withStore((store) => {
    const view = new NotebookView(store);
    press(view, "nnResearch");
    view.handle({ kind: "enter" });
    press(view, "w");
    assertStringIncludes(view.lines(30).join("\n"), "Notebook: Research");
    press(view, "a119 hr1");
    view.handle({ kind: "enter" });
    const notebook = store.listNotebooks().items[0];
    assertEquals(store.countReferences(notebook.id), 1);
    press(view, "a119 HR1");
    view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "already present 1");
    press(view, "edDescription");
    view.handle({ kind: "enter" });
    press(view, "w");
    assertEquals(store.getNotebook(notebook.id)?.description, "Description");
    const action = view.handle({ kind: "enter" });
    assertEquals(action?.kind, "open");
    press(view, "xn");
    assertEquals(store.countReferences(notebook.id), 1);
    press(view, "xy");
    assertEquals(store.countReferences(notebook.id), 0);
    view.handle({ kind: "escape" });
    press(view, "xy");
    assertEquals(store.getNotebook(notebook.id), null);
  });
});

Deno.test("archive menu scopes exports and confirms imports without mutating notebooks", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Archive");
    const view = new NotebookView(store);
    press(view, "wj/tmp/export");
    assertEquals(view.handle({ kind: "enter" }), {
      kind: "archive",
      operation: "json",
      location: "/tmp/export",
      notebookId: undefined,
    });
    view.handle({ kind: "enter" });
    press(view, "wm");
    assertEquals(view.handle({ kind: "enter" }), {
      kind: "archive",
      operation: "markdown",
      location: "",
      notebookId: notebook.id,
    });
    press(view, "wi/tmp/input.json");
    assertEquals(view.handle({ kind: "enter" }), undefined);
    assertStringIncludes(view.lines(30).join("\n"), "committed batches");
    press(view, "n");
    assertEquals(store.listNotebooks().items.length, 1);
    press(view, "i/tmp/input.json");
    view.handle({ kind: "enter" });
    assertEquals(view.handle({ kind: "char", value: "y" }), {
      kind: "archive",
      operation: "import",
      location: "/tmp/input.json",
    });
  });
});

Deno.test("notebook library shows bounded reference and note counts", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Counted");
    store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]);
    store.createNote(notebook.id, { title: "Finding", body: "Body" });
    store.createNotebook("Empty");
    const view = new NotebookView(store);
    const lines = view.lines(30).join("\n");
    assertStringIncludes(lines, "Counted (1 references, 1 notes)");
    assertStringIncludes(lines, "Empty (0 references, 0 notes)");
    store.addReferences(notebook.id, [{ congress: 119, type: "s", number: 2 }]);
    store.createNote(notebook.id, { title: "Second", body: "More" });
    press(view, "r");
    assertStringIncludes(view.lines(30).join("\n"), "Counted (2 references, 2 notes)");
  });
});

Deno.test("notebook UI refreshes one reference or the visible page explicitly", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Refresh");
    store.addReferences(
      notebook.id,
      Array.from({ length: 3 }, (_, index) => ({ congress: 119, type: "hr", number: index + 1 })),
    );
    const view = new NotebookView(store);
    view.handle({ kind: "enter" });
    const highlighted = view.handle({ kind: "char", value: "f" });
    assertEquals(highlighted?.kind, "refresh");
    const page = view.handle({ kind: "char", value: "F" });
    if (page?.kind !== "refreshPage") throw new Error("Expected page refresh");
    assertEquals(page.references.length, 3);
    assertStringIncludes(view.lines(30).join("\n"), "F current page metadata");
    assertEquals(store.countReferences(notebook.id), 3);
  });
});

Deno.test("notebook UI paginates, filters, and compares without restricting membership", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Many");
    store.addReferences(
      notebook.id,
      Array.from({ length: 55 }, (_, index) => ({ congress: 119, type: "hr", number: index + 1 })),
    );
    const view = new NotebookView(store);
    view.handle({ kind: "enter" });
    press(view, "mjmjm");
    assertStringIncludes(view.lines(30).join("\n"), "select (3)");
    assertEquals(view.handle({ kind: "char", value: "c" }), undefined);
    assertStringIncludes(view.lines(30).join("\n"), "exactly two selections");
    press(view, "m");
    assertEquals(view.handle({ kind: "char", value: "c" })?.kind, "compare");
    assertEquals(store.countReferences(notebook.id), 55);
    press(view, "l");
    assertStringIncludes(view.lines(30).join("\n"), "Page 2");
    press(view, "b/hr55");
    view.handle({ kind: "enter" });
    assertStringIncludes(view.lines(30).join("\n"), "HR 55");
  });
});

Deno.test("notebook batch cancellation retains committed additions and allows retry", async () => {
  await withStore(async (store) => {
    const notebook = store.createNotebook("Batch");
    const references = Array.from(
      { length: 501 },
      (_, index) => ({ congress: 119, type: "s", number: index + 1 }),
    );
    const view = new NotebookView(store, references);
    assertEquals(view.handle({ kind: "enter" }), { kind: "add", notebookId: notebook.id });
    await view.addPending(notebook.id, () => view.cancelAddition());
    assertEquals(store.countReferences(notebook.id), 250);
    assertStringIncludes(view.lines(30).join("\n"), "remaining 251");
    await view.addPending(notebook.id, () => {});
    assertEquals(store.countReferences(notebook.id), 501);
    assertStringIncludes(view.lines(30).join("\n"), "Notebook: Batch");
  });
});

Deno.test("notebook delete confirmation rejects concurrent membership changes", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Protected");
    const view = new NotebookView(store);
    press(view, "x");
    store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]);
    press(view, "y");
    assertStringIncludes(view.lines(30).join("\n"), "Reload before saving");
    assertEquals(store.countReferences(notebook.id), 1);
    press(view, "nrxy");
    assertEquals(store.getNotebook(notebook.id), null);
  });
});

Deno.test("notebook drafts survive save failure and require explicit discard", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Original");
    const view = new NotebookView(store);
    press(view, "en");
    for (let count = 0; count < "Original".length; count++) view.handle({ kind: "backspace" });
    press(view, "Draft");
    view.handle({ kind: "enter" });
    store.updateNotebook(notebook.id, notebook.revision, "Concurrent", "");
    press(view, "w");
    assertStringIncludes(view.lines(30).join("\n"), "Title: Draft");
    assertStringIncludes(view.lines(30).join("\n"), "Reload before saving");
    view.handle({ kind: "escape" });
    assertStringIncludes(view.lines(30).join("\n"), "Discard notebook draft?");
    press(view, "n");
    assertStringIncludes(view.lines(30).join("\n"), "Title: Draft");
    view.handle({ kind: "escape" });
    press(view, "yr");
    assertEquals(store.getNotebook(notebook.id)?.title, "Concurrent");
  });
});

Deno.test("failed notebook batch retains committed counts and retries only remaining references", async () => {
  await withStore(async (store) => {
    const notebook = store.createNotebook("Batch failure");
    const references = Array.from(
      { length: 501 },
      (_, index) => ({ congress: 119, type: "hr", number: index + 1 }),
    );
    const add = store.addReferences.bind(store);
    let calls = 0;
    store.addReferences = (id, batch) => {
      if (++calls === 2) throw new Error("Disk full");
      return add(id, batch);
    };
    const view = new NotebookView(store, references);
    await view.addPending(notebook.id, () => {});
    assertStringIncludes(
      view.lines(30).join("\n"),
      "Added 250; already present 0; remaining 251. Disk full",
    );
    assertEquals(store.countReferences(notebook.id), 250);
    await view.addPending(notebook.id, () => {});
    assertEquals(store.countReferences(notebook.id), 501);
  });
});

Deno.test("notebook UI requires a separate explicit citation unlink confirmation", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Cited");
    store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]);
    const reference = store.listReferences(notebook.id).items[0];
    const note = store.createNote(notebook.id, { title: "Research", body: "Keep my notes" }, [
      reference.id,
    ]);
    const view = new NotebookView(store);
    view.handle({ kind: "enter" });
    press(view, "x");
    assertStringIncludes(view.lines(30).join("\n"), "Cited by 1 notes");
    press(view, "y");
    assertEquals(store.countReferences(notebook.id), 1);
    press(view, "u");
    assertStringIncludes(view.lines(30).join("\n"), "Unlink citations from 1 notes");
    assertStringIncludes(view.lines(30).join("\n"), "Note text is preserved");
    press(view, "n");
    assertEquals(store.countCitations(note.id), 1);
    press(view, "xuy");
    assertEquals(store.countReferences(notebook.id), 0);
    assertEquals(store.countCitations(note.id), 0);
    assertEquals(store.getNote(note.id)!.body, "Keep my notes");
  });
});

Deno.test("notebook UI delete confirmation counts notes and rejects notes added afterwards", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Protected notes");
    store.createNote(notebook.id, { title: "First", body: "" });
    const view = new NotebookView(store);
    press(view, "x");
    assertStringIncludes(view.lines(30).join("\n"), "0 references and 1 notes?");
    store.createNote(notebook.id, { title: "New work", body: "Preserve" });
    press(view, "y");
    assertStringIncludes(view.lines(30).join("\n"), "Reload before saving");
    assertEquals(store.countNotes(notebook.id), 2);
    press(view, "nrx");
    assertStringIncludes(view.lines(30).join("\n"), "0 references and 2 notes?");
    press(view, "y");
    assertEquals(store.getNotebook(notebook.id), null);
    assertEquals(store.countNotes(notebook.id), 0);
  });
});

Deno.test("notebook UI unlink confirmation rejects citations changed after preview", async () => {
  await withStore((store) => {
    const notebook = store.createNotebook("Protected citations");
    store.addReferences(notebook.id, [{ congress: 119, type: "hr", number: 1 }]);
    const reference = store.listReferences(notebook.id).items[0];
    const note = store.createNote(notebook.id, { title: "Existing", body: "Keep" }, [reference.id]);
    const view = new NotebookView(store);
    view.handle({ kind: "enter" });
    press(view, "xu");
    store.updateNote(note.id, note.revision, { title: "New work", body: "Keep this too" });
    press(view, "y");
    assertStringIncludes(view.lines(30).join("\n"), "Reload before saving");
    assertEquals(store.countReferences(notebook.id), 1);
    assertEquals(store.countCitations(note.id), 1);
    press(view, "nrxuy");
    assertEquals(store.countReferences(notebook.id), 0);
    assertEquals(store.getNote(note.id)!.body, "Keep this too");
  });
});
