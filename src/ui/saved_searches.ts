import { currentCongress } from "../api/congress.ts";
import type { ResearchStore, SavedSearch, SearchDefinition } from "../research/store.ts";
import type { Key } from "./terminal.ts";

export type SavedSearchRepository = Pick<
  ResearchStore,
  "createSearch" | "getSearch" | "listSearches" | "updateSearch" | "deleteSearch"
>;

type Field = "name" | "query" | "congress" | "filter";
type Mode = "list" | "edit" | "input" | "delete" | "discard";
type Action = { kind: "close" } | { kind: "run"; search: SavedSearch };
const TYPES = [null, "hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"];

export class SavedSearchView {
  private mode: Mode = "list";
  private searches: SavedSearch[] = [];
  private selected = 0;
  private after: string | undefined;
  private nextCursor: string | undefined;
  private previous: Array<string | undefined> = [];
  private filter = "";
  private status = "";
  private original: SavedSearch | null = null;
  private draft: SearchDefinition | null = null;
  private field: Field = "name";
  private input = "";
  private deletion: SavedSearch | null = null;

  constructor(private readonly repository: SavedSearchRepository, seed?: SearchDefinition) {
    this.reload();
    if (seed) this.edit(seed);
  }

  handle(key: Key): Action | undefined {
    try {
      return this.route(key);
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  }

  private route(key: Key): Action | undefined {
    if (this.mode === "input") {
      if (key.kind === "escape") this.mode = this.field === "filter" ? "list" : "edit";
      else if (key.kind === "backspace") this.input = [...this.input].slice(0, -1).join("");
      else if (key.kind === "char") this.input += key.value;
      else if (key.kind === "enter") this.acceptInput();
      return;
    }
    const command = key.kind === "char" ? key.value.toLowerCase() : "";
    if (this.mode === "discard") {
      if (command === "y") {
        this.draft = null;
        this.mode = "list";
        this.status = "Draft discarded.";
      } else if (command === "n" || key.kind === "escape") this.mode = "edit";
      return;
    }
    if (this.mode === "delete") {
      if (command === "y" && this.deletion) {
        this.repository.deleteSearch(this.deletion.id, this.deletion.revision);
        this.deletion = null;
        this.mode = "list";
        this.reload();
        this.status = "Saved search deleted.";
      } else if (command === "n" || key.kind === "escape") {
        this.deletion = null;
        this.mode = "list";
      }
      return;
    }
    if (this.mode === "edit" && this.draft) {
      if (key.kind === "escape") this.mode = "discard";
      else if (command === "n") this.beginInput("name", this.draft.name);
      else if (command === "q") this.beginInput("query", this.draft.query);
      else if (command === "g") {
        this.beginInput(
          "congress",
          String(
            this.draft.congress.mode === "fixed" ? this.draft.congress.congress : currentCongress(),
          ),
        );
      } else if (command === "c") {
        this.draft.congress = this.draft.congress.mode === "current"
          ? { mode: "fixed", congress: currentCongress() }
          : { mode: "current" };
      } else if (command === "t") {
        this.draft.type = TYPES[(TYPES.indexOf(this.draft.type) + 1) % TYPES.length];
      } else if (command === "w") {
        const saved = this.original
          ? this.repository.updateSearch(this.original.id, this.original.revision, this.draft)
          : this.repository.createSearch(this.draft);
        this.draft = null;
        this.original = null;
        this.mode = "list";
        this.reload();
        this.status = `Saved ${saved.name}.`;
      }
      return;
    }
    if (key.kind === "escape") return { kind: "close" };
    if (key.kind === "up" || command === "k") this.selected = Math.max(0, this.selected - 1);
    else if (key.kind === "down" || command === "j") {
      this.selected = Math.min(Math.max(0, this.searches.length - 1), this.selected + 1);
    } else if (key.kind === "home") this.selected = 0;
    else if (key.kind === "end") this.selected = Math.max(0, this.searches.length - 1);
    else if (command === "n") {
      this.edit({
        name: "",
        query: "",
        type: null,
        congress: { mode: "fixed", congress: currentCongress() },
      });
    } else if (command === "/") this.beginInput("filter", this.filter);
    else if (command === "r") this.reload();
    else if (command === "l" && this.nextCursor) {
      const next = this.repository.listSearches({ after: this.nextCursor, name: this.filter });
      this.previous.push(this.after);
      this.after = this.nextCursor;
      this.applyPage(next);
    } else if (command === "b" && this.previous.length) {
      const after = this.previous.at(-1);
      const page = this.repository.listSearches({ after, name: this.filter });
      this.previous.pop();
      this.after = after;
      this.applyPage(page);
    } else {
      const selected = this.searches[this.selected];
      if (!selected) return;
      if (key.kind === "enter" || command === "e" || command === "u") {
        const persisted = this.repository.getSearch(selected.id);
        if (!persisted) throw new Error("Saved search was deleted. Press r to reload.");
        if (key.kind === "enter") return { kind: "run", search: persisted };
        this.edit(
          command === "u" ? { ...persisted, name: `${persisted.name} (copy)` } : persisted,
          command === "e" ? persisted : null,
        );
      } else if (command === "x") {
        this.deletion = selected;
        this.mode = "delete";
      }
    }
  }

  private edit(definition: SearchDefinition, original: SavedSearch | null = null): void {
    this.original = original;
    this.draft = structuredClone(definition);
    this.mode = "edit";
    this.status = "Changes are saved only with w.";
  }

  private beginInput(field: Field, value: string): void {
    this.field = field;
    this.input = value;
    this.mode = "input";
  }

  private acceptInput(): void {
    const value = this.input.trim();
    if (this.field === "filter") {
      const page = this.repository.listSearches({ name: value });
      this.filter = value;
      this.after = undefined;
      this.previous = [];
      this.applyPage(page);
      this.mode = "list";
      return;
    }
    if (!this.draft) return;
    if (!value) throw new Error(`${this.field} must not be empty.`);
    if (this.field === "congress") {
      const congress = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(congress) || congress < 1) {
        throw new Error("Congress must be a positive integer.");
      }
      this.draft.congress = { mode: "fixed", congress };
    } else this.draft[this.field] = value;
    this.mode = "edit";
    this.status = "Draft updated; w saves changes.";
  }

  private applyPage(page: ReturnType<SavedSearchRepository["listSearches"]>): void {
    this.searches = page.items;
    this.nextCursor = page.nextCursor;
    this.selected = 0;
  }

  private reload(): void {
    try {
      const page = this.repository.listSearches({ name: this.filter });
      this.after = undefined;
      this.previous = [];
      this.applyPage(page);
      this.status = "";
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  }

  lines(height: number): string[] {
    let lines: string[];
    if (this.mode === "input") {
      lines = [`  Edit ${this.field}`, "", `  > ${this.input}`, "", "  Enter accept / Esc cancel"];
    } else if (this.mode === "discard") {
      lines = ["  Discard unsaved search changes?", "", "  y discard / n keep editing"];
    } else if (this.mode === "delete") {
      lines = [`  Delete saved search: ${this.deletion?.name}?`, "", "  y delete / n cancel"];
    } else if (this.mode === "edit" && this.draft) {
      lines = [
        `  ${this.original ? "Edit" : "New"} saved search`,
        "",
        `  [n] Name: ${this.draft.name}`,
        `  [q] Query: ${this.draft.query}`,
        `  [t] Bill type: ${this.draft.type ?? "all"}`,
        `  [c] Congress mode: ${this.draft.congress.mode}`,
        `  [g] Fixed congress: ${
          this.draft.congress.mode === "fixed"
            ? this.draft.congress.congress
            : "(current at replay)"
        }`,
        "",
        "  w save / Esc cancel",
      ];
    } else {
      const count = Math.max(1, height - 8);
      const start = Math.max(0, this.selected - count + 1);
      lines = [
        `  Saved searches${this.filter ? `: ${this.filter}` : ""}`,
        "",
        "  Enter run / n new / e edit or rename / u duplicate / x delete",
        "  / name filter / r reload / l next page / b previous page / Esc back",
        `  Page ${this.previous.length + 1}${this.nextCursor ? " (more available)" : ""}`,
        "",
        ...(this.searches.length
          ? this.searches.slice(start, start + count).map((search, index) =>
            `  ${start + index === this.selected ? ">" : " "} ${search.name} | ${search.query} | ${
              search.type ?? "all"
            } | ${search.congress.mode === "fixed" ? search.congress.congress : "current Congress"}`
          )
          : ["  No saved searches."]),
      ];
    }
    return [...lines, "", `  ${this.status}`];
  }
}
