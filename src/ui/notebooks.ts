import { detectBillRef } from "../api/congress.ts";
import { billLabel } from "../compare.ts";
import type { Notebook, NotebookReference, ResearchStore } from "../research/store.ts";
import type { BillRef } from "../types.ts";
import type { Key } from "./terminal.ts";

export type NotebookRepository = Pick<
  ResearchStore,
  | "createNotebook"
  | "getNotebook"
  | "listNotebooks"
  | "updateNotebook"
  | "deleteNotebook"
  | "addReferences"
  | "listReferences"
  | "countReferences"
  | "removeReference"
  | "countNotes"
  | "countCitingNotes"
>;

type Action =
  | { kind: "close" }
  | { kind: "open"; reference: BillRef }
  | {
    kind: "compare";
    references: BillRef[];
  }
  | { kind: "add"; notebookId: string }
  | { kind: "search"; notebookId: string }
  | { kind: "refresh"; reference: NotebookReference }
  | {
    kind: "archive";
    operation: "json" | "markdown" | "import" | "resume";
    location: string;
    notebookId?: string;
  }
  | { kind: "notes"; notebookId: string; referenceIds: string[] };
type Field =
  | "title"
  | "description"
  | "filter"
  | "reference"
  | "json"
  | "markdown"
  | "import"
  | "resume";
type PageState = {
  after?: string;
  next?: string;
  previous: Array<string | undefined>;
  selected: number;
  query: string;
};

export class NotebookView {
  private mode:
    | "browse"
    | "edit"
    | "input"
    | "discard"
    | "delete"
    | "remove"
    | "unlink"
    | "archive"
    | "confirmImport" = "browse";
  private notebooks: Notebook[] = [];
  private references: NotebookReference[] = [];
  private notebook: Notebook | null = null;
  private library: PageState = { previous: [], selected: 0, query: "" };
  private members: PageState = { previous: [], selected: 0, query: "" };
  private original: Notebook | null = null;
  private title = "";
  private description = "";
  private field: Field = "title";
  private input = "";
  private status = "";
  private count = 0;
  private confirmation:
    | { notebook: Notebook; reference?: NotebookReference; count: number; notes: number }
    | null = null;
  private marked = new Map<string, NotebookReference>();
  private addition: AbortController | null = null;

  constructor(
    private readonly repository: NotebookRepository,
    private pending: readonly BillRef[] = [],
  ) {
    this.tryReload();
  }

  cancelAddition(): void {
    this.addition?.abort();
  }

  refresh(): void {
    this.tryReload();
  }

  async addPending(notebookId: string, changed: () => void): Promise<void> {
    if (this.addition) return;
    const controller = new AbortController();
    this.addition = controller;
    let added = 0;
    let existing = 0;
    let processed = 0;
    const pending = this.pending;
    try {
      for (let offset = 0; offset < pending.length; offset += 250) {
        if (controller.signal.aborted) break;
        const result = this.repository.addReferences(
          notebookId,
          pending.slice(offset, offset + 250),
        );
        added += result.added;
        existing += result.existing;
        processed += result.added + result.existing;
        this.status =
          `Adding references: ${processed}/${this.pending.length}; Esc cancels remaining batches.`;
        changed();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const remaining = pending.length - processed;
      this.pending = pending.slice(processed);
      this.status = `${
        controller.signal.aborted ? "Cancelled. " : ""
      }Added ${added}; already present ${existing}; remaining ${remaining}. Committed additions retained.`;
      if (!remaining) this.openNotebook(notebookId);
    } catch (error) {
      this.pending = pending.slice(processed);
      this.status =
        `Added ${added}; already present ${existing}; remaining ${this.pending.length}. ${
          error instanceof Error ? error.message : String(error)
        }`;
    } finally {
      this.addition = null;
      changed();
    }
  }

  handle(key: Key): Action | undefined {
    try {
      return this.route(key);
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  }

  private route(key: Key): Action | undefined {
    if (this.addition) {
      if (key.kind === "escape") this.cancelAddition();
      return;
    }
    if (this.mode === "input") {
      if (key.kind === "escape") {
        this.mode = this.field === "title" || this.field === "description" ? "edit" : "browse";
      } else if (key.kind === "char") this.input += key.value;
      else if (key.kind === "backspace") this.input = [...this.input].slice(0, -1).join("");
      else if (key.kind === "enter") return this.acceptInput();
      return;
    }
    const command = key.kind === "char" ? key.value.toLowerCase() : "";
    if (this.mode === "archive") {
      if (key.kind === "escape") this.mode = "browse";
      else if (command === "j") this.beginInput("json", "");
      else if (command === "m" && this.notebook) this.beginInput("markdown", "");
      else if (command === "i") this.beginInput("import", "");
      else if (command === "r") this.beginInput("resume", "");
      return;
    }
    if (this.mode === "confirmImport") {
      if (command === "n" || key.kind === "escape") this.mode = "archive";
      else if (command === "y") {
        this.mode = "browse";
        return {
          kind: "archive",
          operation: this.field as "import" | "resume",
          location: this.input.trim(),
        };
      }
      return;
    }
    if (this.mode === "discard") {
      if (command === "y") {
        this.mode = "browse";
        this.status = "Draft discarded.";
      } else if (command === "n" || key.kind === "escape") this.mode = "edit";
      return;
    }
    if (this.mode === "delete" || this.mode === "remove" || this.mode === "unlink") {
      if (command === "n" || key.kind === "escape") this.mode = "browse";
      else if (command === "u" && this.mode === "remove" && this.confirmation?.notes) {
        this.mode = "unlink";
      } else if (command === "y" && this.confirmation) {
        const { notebook, reference } = this.confirmation;
        if (reference) {
          this.repository.removeReference(notebook.id, reference.id, notebook.revision, {
            unlinkCitations: this.mode === "unlink",
          });
          this.marked.delete(reference.id);
        } else this.repository.deleteNotebook(notebook.id, notebook.revision);
        this.mode = "browse";
        this.reload();
        this.status = reference ? "Reference removed from this notebook." : "Notebook deleted.";
      }
      return;
    }
    if (this.mode === "edit") {
      if (key.kind === "escape") this.mode = "discard";
      else if (command === "n") this.beginInput("title", this.title);
      else if (command === "d") this.beginInput("description", this.description);
      else if (command === "w") {
        const saved = this.original
          ? this.repository.updateNotebook(
            this.original.id,
            this.original.revision,
            this.title,
            this.description,
          )
          : this.repository.createNotebook(this.title, this.description);
        this.mode = "browse";
        if (this.pending.length) {
          this.notebook = null;
          this.reload();
        } else this.openNotebook(saved.id);
        this.status = `Saved ${saved.title}.`;
      }
      return;
    }
    const page = this.notebook ? this.members : this.library;
    const items = this.notebook ? this.references : this.notebooks;
    if (key.kind === "escape") {
      if (!this.notebook) return { kind: "close" };
      this.notebook = null;
      this.marked.clear();
      this.reload();
    } else if (key.kind === "up" || command === "k") page.selected = Math.max(0, page.selected - 1);
    else if (key.kind === "down" || command === "j") {
      page.selected = Math.min(Math.max(0, items.length - 1), page.selected + 1);
    } else if (key.kind === "home") page.selected = 0;
    else if (key.kind === "end") page.selected = Math.max(0, items.length - 1);
    else if (command === "l" && page.next) this.changePage(page.next, true);
    else if (command === "b" && page.previous.length) this.changePage(page.previous.at(-1), false);
    else if (command === "r") this.reload();
    else if (command === "w") this.mode = "archive";
    else if (command === "/") this.beginInput("filter", page.query);
    else if (command === "n" && !this.notebook) this.edit(null);
    else if (command === "e") this.edit(this.notebook ?? this.notebooks[page.selected] ?? null);
    else if (this.notebook) {
      const reference = this.references[page.selected];
      if (command === "n") {
        return {
          kind: "notes",
          notebookId: this.notebook.id,
          referenceIds: [...this.marked.keys()],
        };
      } else if (command === "s") return { kind: "search", notebookId: this.notebook.id };
      else if (command === "a") this.beginInput("reference", "");
      else if (command === "f" && reference) return { kind: "refresh", reference };
      else if (key.kind === "enter" && reference) return { kind: "open", reference };
      else if ((command === "m" || command === " ") && reference) {
        if (this.marked.has(reference.id)) this.marked.delete(reference.id);
        else this.marked.set(reference.id, reference);
      } else if (command === "c") {
        if (this.marked.size === 2) {
          return { kind: "compare", references: [...this.marked.values()] };
        }
        this.status =
          "Comparison requires exactly two selections. Use n for note citations with any number.";
      } else if (command === "x" && reference) {
        this.confirmation = {
          notebook: this.notebook,
          reference,
          count: this.count,
          notes: this.repository.countCitingNotes(this.notebook.id, reference.id),
        };
        this.mode = "remove";
      }
    } else {
      const notebook = this.notebooks[page.selected];
      if (!notebook) return;
      if (key.kind === "enter") {
        if (this.pending.length) return { kind: "add", notebookId: notebook.id };
        this.openNotebook(notebook.id);
      } else if (command === "x") {
        this.confirmation = {
          notebook,
          count: this.repository.countReferences(notebook.id),
          notes: this.repository.countNotes(notebook.id),
        };
        this.mode = "delete";
      }
    }
  }

  private edit(notebook: Notebook | null): void {
    this.original = notebook;
    this.title = notebook?.title ?? "";
    this.description = notebook?.description ?? "";
    this.mode = "edit";
    this.status = "w saves changes; Esc asks before discarding.";
  }

  private beginInput(field: Field, value: string): void {
    this.field = field;
    this.input = value;
    this.mode = "input";
  }

  private acceptInput(): Action | undefined {
    if (this.field === "json" || this.field === "markdown") {
      this.mode = "browse";
      return {
        kind: "archive",
        operation: this.field,
        location: this.input.trim(),
        notebookId: this.notebook?.id,
      };
    }
    if (this.field === "import" || this.field === "resume") {
      if (!this.input.trim()) throw new Error("A local file path is required.");
      this.mode = "confirmImport";
      return;
    }
    if (this.field === "title" || this.field === "description") {
      if (this.field === "title" && !this.input.trim()) {
        throw new Error("Notebook title is required.");
      }
      if (this.field === "title") this.title = this.input.trim();
      else this.description = this.input.trim();
      this.mode = "edit";
    } else if (this.field === "filter") {
      const page = this.notebook ? this.members : this.library;
      const previous = { ...page };
      page.query = this.input.trim();
      page.after = undefined;
      page.previous = [];
      page.selected = 0;
      try {
        this.reload();
      } catch (error) {
        Object.assign(page, previous);
        throw error;
      }
      this.mode = "browse";
    } else if (this.notebook) {
      const match = /^(\d+)\s+(.+)$/.exec(this.input.trim());
      const ref = match ? detectBillRef(match[2]) : null;
      if (!ref || !match) {
        throw new Error("Enter Congress and bill reference, for example: 119 hr1");
      }
      const result = this.repository.addReferences(this.notebook.id, [{
        ...ref,
        congress: Number(match[1]),
      }]);
      this.reload();
      this.mode = "browse";
      this.status =
        `Added ${result.added}; already present ${result.existing}. Metadata is fetched only when opened.`;
    }
  }

  private openNotebook(id: string): void {
    const notebook = this.repository.getNotebook(id);
    if (!notebook) throw new Error("Notebook was deleted. Reload the library.");
    const page = this.repository.listReferences(id);
    const count = this.repository.countReferences(id);
    this.notebook = notebook;
    this.references = page.items;
    this.members = { previous: [], selected: 0, query: "", next: page.nextCursor };
    this.count = count;
    this.marked.clear();
  }

  private changePage(after: string | undefined, forward: boolean): void {
    const state = this.notebook ? this.members : this.library;
    const previous = { ...state, previous: [...state.previous] };
    if (forward) state.previous.push(state.after);
    else state.previous.pop();
    state.after = after;
    state.selected = 0;
    try {
      this.reload();
    } catch (error) {
      Object.assign(state, previous);
      throw error;
    }
  }

  private tryReload(): void {
    try {
      this.reload();
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  }

  private reload(): void {
    if (this.notebook) {
      const notebook = this.repository.getNotebook(this.notebook.id);
      if (!notebook) throw new Error("Notebook was deleted. Esc returns to the library.");
      const page = this.repository.listReferences(notebook.id, this.members);
      this.count = this.repository.countReferences(notebook.id);
      this.notebook = notebook;
      this.references = page.items;
      this.members.next = page.nextCursor;
      this.members.selected = Math.max(0, Math.min(this.members.selected, page.items.length - 1));
    } else {
      const page = this.repository.listNotebooks(this.library);
      this.notebooks = page.items;
      this.library.next = page.nextCursor;
      this.library.selected = Math.max(0, Math.min(this.library.selected, page.items.length - 1));
    }
  }

  lines(height: number): string[] {
    let lines: string[];
    if (this.mode === "archive") {
      lines = [
        "  Research archive",
        "",
        `  Scope: ${this.notebook?.title ?? "All notebooks and saved searches"}`,
        "  j JSON export",
        ...(this.notebook ? ["  m Markdown export"] : []),
        "  i import JSON / r resume staged import / Esc back",
      ];
    } else if (this.mode === "confirmImport") {
      lines = [
        "  Import research?",
        `  ${this.input}`,
        "",
        "  New notebook/search/note IDs; canonical references deduplicated.",
        "  Existing metadata wins on canonical collisions. No URLs are fetched.",
        "  Validation precedes changes. Commits use resumable batches of 250.",
        "  Cancel/failure retains committed batches and private staging for resume.",
        "  y confirm / n cancel",
      ];
    } else if (this.mode === "input") {
      lines = [
        `  Edit ${this.field}${
          this.field === "reference" ? " (Congress and bill, e.g. 119 hr1)" : ""
        }`,
        "",
        `  > ${this.input}`,
        "",
        this.field === "json" || this.field === "markdown"
          ? "  Destination directory (blank uses configured export directory). Enter export / Esc cancel"
          : "  Enter accept / Esc cancel",
      ];
    } else if (this.mode === "edit") {
      lines = [
        `  ${this.original ? "Edit" : "New"} notebook`,
        "",
        `  [n] Title: ${this.title}`,
        `  [d] Description: ${this.description}`,
        "",
        "  w save / Esc cancel",
      ];
    } else if (this.mode === "discard") {
      lines = ["  Discard notebook draft?", "  y discard / n keep editing"];
    } else if (this.mode === "delete" || this.mode === "remove" || this.mode === "unlink") {
      lines = [
        this.mode === "delete"
          ? `  Delete ${this.confirmation?.notebook.title} and its ${this.confirmation?.count} references and ${this.confirmation?.notes} notes?`
          : this.mode === "unlink"
          ? `  Unlink citations from ${this.confirmation?.notes} notes and remove ${
            billLabel(this.confirmation!.reference!)
          }? Note text is preserved.`
          : `  Remove ${billLabel(this.confirmation!.reference!)} from this notebook?`,
        "  Other notebooks are unchanged.",
        "",
        this.mode === "remove" && this.confirmation?.notes
          ? `  Cited by ${this.confirmation.notes} notes. Removal blocked: u review unlink / n cancel`
          : "  y confirm / n cancel",
      ];
    } else {
      const state = this.notebook ? this.members : this.library;
      const available = Math.max(
        1,
        height - 10 - (this.notebook ? 1 + this.metadataLines().length : 0),
      );
      const start = Math.max(0, state.selected - available + 1);
      const rows = this.notebook
        ? this.references.map((ref) =>
          `${this.marked.has(ref.id) ? "*" : " "} ${billLabel(ref)}${
            ref.metadata?.title ? ` | ${ref.metadata.title}` : " | unresolved"
          }`
        )
        : this.notebooks.map((notebook) => notebook.title);
      lines = [
        this.notebook
          ? `  Notebook: ${this.notebook.title} (${this.count} references)`
          : "  Notebooks",
        this.notebook
          ? `  ${this.notebook.description}`
          : this.pending.length
          ? `  Add ${this.pending.length} selected/loaded references: Enter chooses a notebook.`
          : "",
        this.notebook
          ? `  n notes / Enter details / a add / e edit / x remove / Space/m select (${this.marked.size}) / c compare two`
          : "  Enter open or add / n new / e edit / x delete",
        "  w archive export/import",
        `${
          this.notebook ? "  s search and add /" : " "
        } / filter / l next page / b previous / r reload / Esc back`,
        `  Page ${state.previous.length + 1}${state.next ? " (more available)" : ""}${
          state.query ? ` | Filter: ${state.query}` : ""
        }`,
        "",
        ...(this.notebook
          ? ["  f refresh highlighted metadata (network)", ...this.metadataLines()]
          : []),
        ...(rows.length
          ? rows.slice(start, start + available).map((row, index) =>
            `  ${start + index === state.selected ? ">" : " "} ${row}`
          )
          : ["  No entries."]),
      ];
    }
    return [...lines, "", `  ${this.status}`];
  }

  private metadataLines(): string[] {
    const metadata = this.references[this.members.selected]?.metadata;
    if (!metadata) return [];
    const stale = metadata.refreshError || !metadata.retrievedAt ||
      Date.now() - Date.parse(metadata.retrievedAt) > 86_400_000;
    return [
      `  Metadata: ${stale ? "stale" : "fresh"} | Retrieved: ${
        metadata.retrievedAt ?? "never"
      } | Source updated: ${metadata.sourceUpdatedAt || "unknown"}`,
      ...(metadata.refreshError ? [`  ${metadata.refreshError}`] : []),
      ...metadata.limitations.map((notice) => `  ${notice}`),
    ];
  }
}
