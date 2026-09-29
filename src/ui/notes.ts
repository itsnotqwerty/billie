import { type NoteDraft, NoteDrafts } from "../research/editor.ts";
import type { Note, NoteSummary, ResearchStore } from "../research/store.ts";
import type { Key } from "./terminal.ts";
import { type CitationRepository, CitationView } from "./citations.ts";
import type { BillRef } from "../types.ts";
import { type ExportBundle, exportMarkdown, markdownToPlainText } from "../export.ts";
import { billLabel } from "../compare.ts";

export type NotesRepository =
  & Pick<
    ResearchStore,
    "createNote" | "getNote" | "listNotes" | "updateNote" | "deleteNote" | "countCitations"
  >
  & CitationRepository;
type Action =
  | { kind: "close" }
  | { kind: "search" }
  | { kind: "edit"; filePath: string }
  | {
    kind: "generate";
    prompt: string;
  }
  | { kind: "cancelGeneration" }
  | { kind: "export"; bundle: ExportBundle; baseName: string };

export class NotesView {
  private mode:
    | "list"
    | "read"
    | "title"
    | "review"
    | "discard"
    | "delete"
    | "prompt"
    | "generating" = "list";
  private notes: NoteSummary[] = [];
  private selected = 0;
  private after?: string;
  private next?: string;
  private previous: Array<string | undefined> = [];
  private note: Note | null = null;
  private draft: NoteDraft | null = null;
  private body = "";
  private input = "";
  private scroll = 0;
  private status = "";
  private deleting: NoteSummary | null = null;
  private citationCount = 0;
  private citations: CitationView | null = null;

  constructor(
    private readonly repository: NotesRepository,
    private readonly drafts: NoteDrafts,
    private readonly notebookId: string,
    private selectedReferenceIds: string[] = [],
    private readonly ai?: { destination: string; model: string; exportDir: string },
  ) {
    try {
      this.reload();
    } catch (error) {
      this.status = this.message(error);
    }
  }

  async handle(key: Key): Promise<Action | undefined> {
    try {
      return await this.route(key);
    } catch (error) {
      this.status = this.message(error);
    }
  }

  async editorReturned(error?: unknown): Promise<void> {
    this.mode = "review";
    this.scroll = 0;
    this.status = error
      ? this.message(error)
      : "Editor closed. Changes are not saved to the notebook yet.";
    try {
      this.body = await this.drafts.read(this.draft!);
    } catch (readError) {
      this.status += ` ${this.message(readError)}`;
    }
  }

  citeReference(reference: BillRef): string {
    if (!this.citations) throw new Error("Open a saved note's citations first.");
    return this.citations.citeReference(reference);
  }

  generationFailed(error: unknown): void {
    this.mode = "prompt";
    this.status = this.message(error);
  }

  async generated(markdown: string, model: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (!markdown.trim()) throw new Error("AI provider returned an empty note.");
    const body =
      `> AI-generated draft | Model: ${JSON.stringify(model)} | ${new Date().toISOString()}\n` +
      "> Prompt only; no notebook records or source documents supplied. Verify claims before use.\n\n" +
      markdown;
    const draft = await this.drafts.create({
      notebookId: this.notebookId,
      noteId: null,
      revision: null,
      title: this.input.trim().slice(0, 200),
      body,
      exportOnSave: true,
    });
    if (signal.aborted) return;
    this.draft = draft;
    this.body = body;
    this.scroll = 0;
    this.mode = "review";
    this.status = "AI draft ready. Not saved to the notebook. e edits; w saves directly.";
  }

  private async route(key: Key): Promise<Action | undefined> {
    if (this.citations) {
      const action = this.citations.handle(key);
      if (action === "search") return { kind: "search" };
      if (action === "close") {
        this.citations = null;
        this.reload();
        if (this.mode === "read" && this.note) {
          const current = this.repository.getNote(this.note.id);
          if (current) {
            this.note = current;
            this.body = current.body;
            this.citationCount = this.repository.countCitations(current.id);
          } else {
            this.mode = "list";
            this.status = "Note was deleted.";
          }
        }
      }
      return;
    }
    const command = key.kind === "char" ? key.value : "";
    if (this.mode === "generating") {
      if (key.kind === "escape") {
        this.mode = "prompt";
        this.status = "Generation cancelled.";
        return { kind: "cancelGeneration" };
      }
      return;
    }
    if (this.mode === "prompt") {
      if (key.kind === "escape") this.mode = "list";
      else if (key.kind === "char") this.input += key.value;
      else if (key.kind === "backspace") this.input = [...this.input].slice(0, -1).join("");
      else if (key.kind === "enter") {
        if (!this.input.trim() || this.input.length > 20_000) {
          throw new Error("Prompt must contain 1 to 20000 characters.");
        }
        this.mode = "generating";
        this.status = "";
        return { kind: "generate", prompt: this.input.trim() };
      }
      return;
    }
    if (this.mode === "title") {
      if (key.kind === "escape") this.mode = this.draft ? "review" : "list";
      else if (key.kind === "char") this.input += key.value;
      else if (key.kind === "backspace") this.input = [...this.input].slice(0, -1).join("");
      else if (key.kind === "enter") {
        if (!this.input.trim()) throw new Error("Note title is required.");
        if (this.draft) {
          this.draft = await this.drafts.rename(this.draft, this.input.trim());
          this.mode = "review";
        } else {
          this.draft = await this.drafts.create({
            notebookId: this.notebookId,
            noteId: null,
            revision: null,
            title: this.input.trim(),
            body: "",
          });
          this.body = "";
          this.mode = "review";
          return { kind: "edit", filePath: this.draft.filePath };
        }
      }
      return;
    }
    if (this.mode === "discard") {
      if (command === "y") {
        await this.drafts.discard(this.draft!);
        this.draft = null;
        this.mode = "list";
        this.status = "Draft discarded. Stored note unchanged.";
        this.reload();
      } else if (command === "n" || key.kind === "escape") this.mode = "review";
      return;
    }
    if (this.mode === "delete") {
      if (command === "y") {
        this.repository.deleteNote(this.deleting!.id, this.deleting!.revision);
        this.mode = "list";
        this.reload();
        this.status = "Note deleted; notebook references retained.";
      } else if (command === "n" || key.kind === "escape") this.mode = "list";
      return;
    }
    if (this.mode === "review") {
      if (key.kind === "escape" || command === "d") this.mode = "discard";
      else if (command === "W") {
        const draft = this.draft!;
        return this.exportNote({
          id: draft.noteId,
          notebookId: draft.notebookId,
          title: draft.title,
          body: await this.drafts.read(draft),
          revision: draft.revision,
        }, true);
      } else if (command === "t") {
        this.input = this.draft!.title;
        this.mode = "title";
      } else if (command === "c" || command === "e") {
        await this.drafts.read(this.draft!);
        return { kind: "edit", filePath: this.draft!.filePath };
      } else if (command === "w" || command === "k") await this.save(command === "k");
      else this.move(key);
      return;
    }
    if (this.mode === "read") {
      if (key.kind === "escape") this.mode = "list";
      else if (command === "e") return await this.edit(this.note!.id);
      else if (command === "c") this.openCitations(this.note!.id);
      else if (command === "w") return this.exportSavedNote(this.note!.id);
      else this.move(key);
      return;
    }
    if (key.kind === "escape") return { kind: "close" };
    if (command === "a") {
      this.input = "";
      this.mode = "prompt";
      this.status = "";
    } else if (command === "n" || (command === "e" && this.notes.length === 0)) {
      this.input = "";
      this.mode = "title";
    } else if (command === "R") {
      const draft = await this.drafts.latest(this.notebookId);
      if (!draft) throw new Error("No recovery draft found for this notebook.");
      this.draft = draft;
      await this.editorReturned();
      this.status =
        "Recovered draft. Original revision retained; conflicts will not overwrite newer work.";
    } else if (command === "r") this.reload();
    else if (key.kind === "down" || command === "j") {
      this.selected = Math.min(Math.max(0, this.notes.length - 1), this.selected + 1);
    } else if (key.kind === "up" || command === "k") this.selected = Math.max(0, this.selected - 1);
    else if (key.kind === "home") this.selected = 0;
    else if (key.kind === "end") this.selected = Math.max(0, this.notes.length - 1);
    else if (command === "l" && this.next) this.page(this.next, true);
    else if (command === "b" && this.previous.length) this.page(this.previous.at(-1), false);
    else {
      const selected = this.notes[this.selected];
      if (!selected) return;
      if (command === "c") {
        this.openCitations(selected.id);
        return;
      }
      if (command === "e") return await this.edit(selected.id);
      if (command === "w") return this.exportSavedNote(selected.id);
      if (key.kind === "enter") {
        const note = this.repository.getNote(selected.id);
        if (!note) throw new Error("Note was deleted. Reload the list.");
        this.note = note;
        this.body = note.body;
        this.citationCount = this.repository.countCitations(note.id);
        this.scroll = 0;
        this.mode = "read";
      } else if (command === "x") {
        this.deleting = selected;
        this.citationCount = this.repository.countCitations(selected.id);
        this.mode = "delete";
      }
    }
  }

  private exportSavedNote(id: string): Action {
    const note = this.repository.getNote(id);
    if (!note || note.notebookId !== this.notebookId) {
      throw new Error("Note was deleted. Reload the list.");
    }
    return this.exportNote(note, false);
  }

  private exportNote(
    note: {
      id: string | null;
      notebookId: string;
      title: string;
      body: string;
      revision: number | null;
    },
    unsavedDraft: boolean,
  ): Action {
    const citations = [];
    let after: string | undefined;
    if (note.id) {
      do {
        const page = this.repository.listCitations(note.id, { after });
        citations.push(...page.items);
        after = page.nextCursor;
      } while (after);
    }
    const markdown = [
      `# ${note.title.replace(/[\r\n]+/g, " ")}`,
      "",
      unsavedDraft
        ? "> Unsaved research note draft; not an authoritative legislative record."
        : "> Research note; not an authoritative legislative record.",
      "",
      note.body,
      ...(citations.length
        ? [
          "",
          "## Structured citations",
          "",
          ...citations.map((ref) => `- ${billLabel(ref)} (Congress.gov reference)`),
        ]
        : []),
      "",
    ].join("\n");
    return {
      kind: "export",
      baseName: `note-${note.id ?? crypto.randomUUID()}${unsavedDraft ? "-draft" : ""}`,
      bundle: {
        title: note.title,
        data: { kind: "note", unsavedDraft, note, citations },
        markdown,
        text: markdownToPlainText(markdown),
      },
    };
  }

  private async edit(id: string): Promise<Action> {
    const note = this.repository.getNote(id);
    if (!note) throw new Error("Note was deleted. Reload the list.");
    this.draft = await this.drafts.create({
      notebookId: this.notebookId,
      noteId: note.id,
      revision: note.revision,
      title: note.title,
      body: note.body,
    });
    this.body = note.body;
    this.mode = "review";
    return { kind: "edit", filePath: this.draft.filePath };
  }

  private openCitations(id: string): void {
    const note = this.repository.getNote(id);
    if (!note || note.notebookId !== this.notebookId) {
      throw new Error("Note was deleted. Reload the list.");
    }
    this.citations = new CitationView(this.repository, note, this.selectedReferenceIds);
    this.selectedReferenceIds = [];
  }

  private async save(copy: boolean): Promise<void> {
    const draft = this.draft!;
    const body = await this.drafts.read(draft);
    let exported: string | undefined;
    if (draft.exportOnSave) {
      if (!this.ai) throw new Error("No Markdown export directory configured; draft retained.");
      exported = await exportMarkdown(this.ai.exportDir, `note-${crypto.randomUUID()}`, body);
    }
    let saved: NoteSummary;
    try {
      saved = draft.noteId && !copy
        ? this.repository.updateNote(draft.noteId, draft.revision!, { title: draft.title, body })
        : this.repository.createNote(this.notebookId, {
          title: copy ? `${draft.title} (copy)` : draft.title,
          body,
        });
    } catch (error) {
      throw new Error(
        `${exported ? `Markdown written to ${exported}; notebook save failed. ` : ""}${
          this.message(error)
        }`,
      );
    }
    this.draft = null;
    this.mode = "list";
    this.status = `Saved ${saved.title}.${copy ? " Copy has no structured citations." : ""}`;
    if (exported) this.status += ` Markdown: ${exported}`;
    try {
      await this.drafts.discard(draft);
    } catch (error) {
      this.status += ` Recovery cleanup failed at ${draft.directory}: ${this.message(error)}`;
    }
    this.reload();
  }

  private reload(): void {
    const page = this.repository.listNotes(this.notebookId, { after: this.after });
    this.notes = page.items;
    this.next = page.nextCursor;
    this.selected = Math.max(0, Math.min(this.selected, this.notes.length - 1));
  }

  private page(after: string | undefined, forward: boolean): void {
    const page = this.repository.listNotes(this.notebookId, { after });
    if (forward) this.previous.push(this.after);
    else this.previous.pop();
    this.after = after;
    this.notes = page.items;
    this.next = page.nextCursor;
    this.selected = 0;
  }

  private move(key: Key): void {
    const command = key.kind === "char" ? key.value : "";
    if (key.kind === "down" || command === "j") this.scroll++;
    else if (key.kind === "up" || command === "k") this.scroll--;
    else if (key.kind === "pagedown") this.scroll += 10;
    else if (key.kind === "pageup") this.scroll -= 10;
    else if (key.kind === "home") this.scroll = 0;
    else if (key.kind === "end") this.scroll = this.body.split("\n").length - 1;
    this.scroll = Math.max(0, Math.min(this.scroll, this.body.split("\n").length - 1));
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  lines(height: number): string[] {
    if (this.citations) return this.citations.lines(height);
    let lines: string[];
    if (this.mode === "prompt" || this.mode === "generating") {
      lines = [
        "  Generate AI note",
        `  Destination: ${this.ai?.destination ?? "AI provider not configured"}`,
        `  Model: ${this.ai?.model ?? "unavailable"}`,
        "  Sends only this prompt; no notebook contents or selected references.",
        `  > ${this.input}`,
        this.mode === "generating"
          ? "  Generating... Esc cancel"
          : "  Enter send prompt / Esc cancel",
      ];
    } else if (this.mode === "title") {
      lines = ["  Note title", "", `  > ${this.input}`, "", "  Enter accept / Esc cancel"];
    } else if (this.mode === "discard") {
      lines = [
        "  Discard this draft and its recovery files? Stored note is unchanged.",
        "  y discard / n keep editing",
        `  ${this.draft?.filePath}`,
      ];
    } else if (this.mode === "delete") {
      lines = [
        `  Delete ${this.deleting?.title} and its ${this.citationCount} citations?`,
        "  Notebook references are retained.",
        "  y confirm / n cancel",
      ];
    } else if (this.mode === "read" || this.mode === "review") {
      lines = [
        `  ${this.mode === "review" ? "Unsaved draft" : "Note"}: ${
          this.draft?.title ?? this.note?.title
        }`,
        this.mode === "review"
          ? this.draft?.exportOnSave
            ? "  e Edit in micro / w Save note + Markdown / W Export / d Discard / t title"
            : "  w Save / d Discard / c Continue in micro (or e) / W Export / t title / k Save copy"
          : `  e edit in micro / c citations / w export / Esc back | ${this.citationCount} citations`,
        this.mode === "review"
          ? `  Recovery: ${this.draft!.filePath}${
            this.draft!.exportOnSave ? ` | Export: ${this.ai?.exportDir ?? "unavailable"}` : ""
          }`
          : "",
        "  Up/Down or PgUp/PgDn scroll",
        "",
        ...this.body.split("\n").slice(this.scroll, this.scroll + Math.max(1, height - 8)).map((
          line,
        ) => `  ${line}`),
      ];
    } else {
      const available = Math.max(1, height - 7);
      const start = Math.max(0, this.selected - available + 1);
      lines = [
        `  Notes${
          this.selectedReferenceIds.length
            ? ` (${this.selectedReferenceIds.length} notebook references selected for citations)`
            : ""
        }`,
        this.notes.length
          ? "  n new / a AI note / Enter read / e micro / c citations / w export / x delete / r reload / R recover"
          : "  n/e new note in micro / a AI note / r reload / R recover latest draft",
        `  l next / b previous / Esc back | Page ${this.previous.length + 1}${
          this.next ? " (more available)" : ""
        }`,
        "",
        ...(this.notes.length
          ? this.notes.slice(start, start + available).map((note, index) =>
            `  ${start + index === this.selected ? ">" : " "} ${note.title}`
          )
          : ["  No notes."]),
      ];
    }
    return [...lines, "", `  ${this.status}`];
  }
}
