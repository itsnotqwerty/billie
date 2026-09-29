import { billLabel } from "../compare.ts";
import type { BillRef } from "../types.ts";
import type { NotebookReference, NoteSummary, ResearchStore } from "../research/store.ts";
import type { Key } from "./terminal.ts";

export type CitationRepository = Pick<
  ResearchStore,
  | "getNote"
  | "listCitations"
  | "listReferences"
  | "changeCitations"
  | "countCitations"
  | "citeReference"
>;

type Page = {
  after?: string;
  next?: string;
  previous: Array<string | undefined>;
  selected: number;
  query: string;
  items: NotebookReference[];
};

export class CitationView {
  private note: NoteSummary;
  private cited: Page = { previous: [], selected: 0, query: "", items: [] };
  private available: Page = { previous: [], selected: 0, query: "", items: [] };
  private adding = false;
  private mode: "browse" | "filter" | "remove" = "browse";
  private input = "";
  private removal: NotebookReference | null = null;
  private count = 0;
  private marked = new Set<string>();
  private status = "";

  constructor(
    private readonly repository: CitationRepository,
    note: NoteSummary,
    selectedReferenceIds: readonly string[] = [],
  ) {
    this.note = note;
    this.load(this.cited, false);
    if (selectedReferenceIds.length) {
      this.marked = new Set(selectedReferenceIds);
      this.load(this.available, true);
      this.adding = true;
    }
  }

  handle(key: Key): "close" | "search" | undefined {
    try {
      return this.route(key);
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  }

  citeReference(reference: BillRef): string {
    const updated = this.repository.citeReference(this.note.id, this.note.revision, reference);
    const added = updated.revision !== this.note.revision;
    this.note = updated;
    this.status = `${billLabel(reference)}: ${added ? "citation added" : "already cited"}.`;
    this.load(this.cited, false);
    if (this.adding) this.load(this.available, true);
    return this.status;
  }

  private route(key: Key): "close" | "search" | undefined {
    const command = key.kind === "char" ? key.value : "";
    const page = this.adding ? this.available : this.cited;
    if (this.mode === "filter") {
      if (key.kind === "escape") this.mode = "browse";
      else if (key.kind === "char") this.input += key.value;
      else if (key.kind === "backspace") this.input = [...this.input].slice(0, -1).join("");
      else if (key.kind === "enter") {
        const replacement: Page = {
          previous: [],
          selected: 0,
          query: this.input.trim(),
          items: [],
        };
        this.load(replacement, this.adding);
        if (this.adding) this.available = replacement;
        else this.cited = replacement;
        this.mode = "browse";
      }
      return;
    }
    if (this.mode === "remove") {
      if (command === "n" || key.kind === "escape") this.mode = "browse";
      else if (command === "y" && this.removal) {
        this.note = this.repository.changeCitations(this.note.id, this.note.revision, {
          remove: [this.removal.id],
        });
        this.mode = "browse";
        this.status = "Citation removed. Note text and notebook membership unchanged.";
        this.load(this.cited, false);
      }
      return;
    }
    if (key.kind === "escape") {
      if (!this.adding) return "close";
      this.load(this.cited, false);
      this.adding = false;
    } else if (command === "s") {
      return "search";
    } else if (command === "r") {
      const latest = this.repository.getNote(this.note.id);
      if (!latest || latest.notebookId !== this.note.notebookId) {
        throw new Error("Note was deleted. Esc returns to Notes.");
      }
      this.load(page, this.adding);
      this.note = latest;
      this.status = "Reloaded current note and citations.";
    } else if (command === "a" && !this.adding) {
      this.load(this.available, true);
      this.adding = true;
    } else if (command === "/") {
      this.input = page.query;
      this.mode = "filter";
    } else if (key.kind === "down" || command === "j") {
      page.selected = Math.min(Math.max(0, page.items.length - 1), page.selected + 1);
    } else if (key.kind === "up" || command === "k") page.selected = Math.max(0, page.selected - 1);
    else if (key.kind === "home") page.selected = 0;
    else if (key.kind === "end") page.selected = Math.max(0, page.items.length - 1);
    else if (command === "l" && page.next) this.changePage(page, page.next, true);
    else if (command === "b" && page.previous.length) {
      this.changePage(page, page.previous.at(-1), false);
    } else if (this.adding && key.kind === "enter" && this.marked.size) {
      this.addMarked();
    } else {
      const reference = page.items[page.selected];
      if (!reference) return;
      if (this.adding && (command === " " || command === "m")) {
        if (!this.marked.delete(reference.id)) this.marked.add(reference.id);
      } else if (this.adding && key.kind === "enter") {
        const updated = this.repository.changeCitations(this.note.id, this.note.revision, {
          add: [reference.id],
        });
        const added = updated.revision !== this.note.revision;
        this.note = updated;
        this.count = this.repository.countCitations(this.note.id);
        this.status = `${billLabel(reference)}: ${added ? "citation added" : "already cited"}.`;
      } else if (!this.adding && command === "x") {
        this.removal = reference;
        this.mode = "remove";
      }
    }
  }

  private addMarked(): void {
    let processed = 0;
    const selected = [...this.marked];
    try {
      for (let offset = 0; offset < selected.length; offset += 250) {
        const batch = selected.slice(offset, offset + 250);
        this.note = this.repository.changeCitations(this.note.id, this.note.revision, {
          add: batch,
        });
        for (const id of batch) this.marked.delete(id);
        processed += batch.length;
      }
      this.status = `Applied ${processed} selected references. Already-cited references unchanged.`;
    } catch (error) {
      this.status = `Applied ${processed}; ${this.marked.size} selected references remaining. ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    this.count = this.repository.countCitations(this.note.id);
  }

  private load(page: Page, adding: boolean): void {
    const result = adding
      ? this.repository.listReferences(this.note.notebookId, page)
      : this.repository.listCitations(this.note.id, page);
    const count = this.repository.countCitations(this.note.id);
    page.items = result.items;
    page.next = result.nextCursor;
    page.selected = Math.max(0, Math.min(page.selected, page.items.length - 1));
    this.count = count;
  }

  private changePage(page: Page, after: string | undefined, forward: boolean): void {
    const candidate: Page = { ...page, after, selected: 0, previous: [...page.previous] };
    if (forward) candidate.previous.push(page.after);
    else candidate.previous.pop();
    this.load(candidate, this.adding);
    Object.assign(page, candidate);
  }

  lines(height: number): string[] {
    let lines: string[];
    if (this.mode === "filter") {
      lines = [
        "  Filter references (e.g. 119 hr1)",
        "",
        `  > ${this.input}`,
        "  Enter apply / Esc cancel",
      ];
    } else if (this.mode === "remove") {
      lines = [
        `  Remove citation to ${billLabel(this.removal!)} from ${this.note.title}?`,
        "  Note text and notebook membership are unchanged.",
        "",
        "  y confirm / n cancel",
      ];
    } else {
      const page = this.adding ? this.available : this.cited;
      const visible = Math.max(1, height - 8);
      const start = Math.max(0, page.selected - visible + 1);
      lines = [
        `  ${
          this.adding ? "Add citations" : "Citations"
        }: ${this.note.title} (${this.count} cited)`,
        this.adding
          ? `  Space/m toggle (${this.marked.size} selected) / Enter add selected / Esc return to citations`
          : "  a add from notebook / x remove selected / Esc back",
        "  s search legislation / / filter / l next / b previous / r reload / Up/Down select",
        `  Page ${page.previous.length + 1}${page.next ? " (more available)" : ""}${
          page.query ? ` | Filter: ${page.query}` : ""
        }`,
        "",
        ...(page.items.length
          ? page.items.slice(start, start + visible).map((ref, index) =>
            `  ${start + index === page.selected ? ">" : " "} ${
              this.adding && this.marked.has(ref.id) ? "* " : ""
            }${billLabel(ref)}`
          )
          : [
            this.adding
              ? "  No matching notebook references. Add legislation to the notebook first."
              : "  No matching citations.",
          ]),
      ];
    }
    return [...lines, "", `  ${this.status}`];
  }
}
