/** Application state machine: views, commands, and orchestration. */

import { type AnalysisResult, OpenAiCompatProvider } from "../ai/provider.ts";
import { CongressClient, currentCongress } from "../api/congress.ts";
import { type BillComparison, billLabel, compareBills } from "../compare.ts";
import {
  type AppConfig,
  configPath,
  expandHomePath,
  maskSecret,
  saveAiApiKey,
  saveAiBaseUrl,
  saveAiModel,
  saveCongressApiKey,
  saveExportDir,
} from "../config.ts";
import {
  analysisToMarkdown,
  billTextToMarkdown,
  billToMarkdown,
  comparisonAnalysisToMarkdown,
  comparisonTextToMarkdown,
  comparisonToMarkdown,
  type ExportBundle,
  type ExportFileType,
  type ExportStyle,
  markdownToPlainText,
  serializeExport,
  writeExport,
} from "../export.ts";
import type { BillDetail, BillSummary, BillText } from "../types.ts";
import { pairColumns, sideBySide } from "./columns.ts";
import { type FindHit, findInTexts, stepHit } from "./find.ts";
import { type Key, Terminal, truncate, wrap } from "./terminal.ts";

type ViewName =
  | "menu"
  | "config"
  | "configEdit"
  | "modelPick"
  | "search"
  | "find"
  | "results"
  | "detail"
  | "compare"
  | "analysis"
  | "analysisQuery"
  | "export"
  | "exportPathEdit"
  | "help";

type ConfigField = "congressApiKey" | "aiApiKey" | "aiModel" | "aiBaseUrl";

const CONFIG_FIELD_LABELS: Record<ConfigField, string> = {
  congressApiKey: "Congress.gov API key",
  aiApiKey: "AI API key",
  aiModel: "AI model",
  aiBaseUrl: "AI base URL",
};
const INPUT_VIEWS: ReadonlySet<ViewName> = new Set([
  "configEdit",
  "search",
  "find",
  "analysisQuery",
  "exportPathEdit",
]);
const MAX_DETAIL_ACTIONS = 25;
const EXPORT_TYPES: ExportFileType[] = ["markdown", "xml", "json", "csv", "html", "pdf"];
const EXPORT_STYLES: ExportStyle[] = ["formatted", "plain"];
const EXPORT_SCOPES = ["document", "view"] as const;

type ExportScope = typeof EXPORT_SCOPES[number];
interface ExportContext {
  bundle: ExportBundle;
  baseName: string;
  visibleLines: string[];
}

/** Bill-type filter cycle, in display order. null means "all types". */
const BILL_TYPE_FILTERS: ReadonlyArray<string | null> = [
  null,
  "hr",
  "s",
  "hjres",
  "sjres",
  "hconres",
  "sconres",
  "hres",
  "sres",
];

export class App {
  private readonly term = new Terminal();
  private client: CongressClient | null = null;
  private provider: OpenAiCompatProvider | null = null;
  private view: ViewName = "menu";
  private history: ViewName[] = [];
  private status = "";
  private input = "";
  private configField: ConfigField | null = null;
  private availableModels: string[] = [];
  private modelSelection = 0;
  private results: BillSummary[] = [];
  private selected = 0;
  private detail: BillDetail | null = null;
  private detailMode: "overview" | "text" = "overview";
  private compareMode: "overview" | "text" = "overview";
  private billTexts = new Map<string, BillText>();
  private textErrors = new Map<string, string>();
  private comparison: BillComparison | null = null;
  private analysis: { result: AnalysisResult; model: string } | null = null;
  private analysisBill: BillDetail | null = null;
  private analysisComparison: BillComparison | null = null;
  private analysisQuestion = "";
  private marked = new Map<string, BillSummary>();
  private filterType: string | null = null;
  private filterCongress: number = currentCongress();
  private lastQuery = "";
  private scroll = 0;
  private findQuery = "";
  private findHits: FindHit[] = [];
  private findIndex = -1;
  private pendingFindQuery: string | null = null;
  private loading: string | null = null;
  private pending: AbortController | null = null;
  private running = false;
  private exportContext: ExportContext | null = null;
  private exportType: ExportFileType = "markdown";
  private exportStyle: ExportStyle = "formatted";
  private exportScope: ExportScope = "document";
  private exportMenuSelection = 0;

  constructor(private config: AppConfig) {
    this.resetClient();
  }

  private resetClient(): void {
    this.client = this.config.congressApiKey
      ? new CongressClient({
        apiKey: this.config.congressApiKey,
        timeoutMs: this.config.requestTimeoutMs,
      })
      : null;
    this.provider = this.config.aiApiKey
      ? new OpenAiCompatProvider({
        apiKey: this.config.aiApiKey,
        model: this.config.aiModel,
        baseUrl: this.config.aiBaseUrl,
        timeoutMs: this.config.aiTimeoutMs,
      })
      : null;
  }

  async run(): Promise<void> {
    this.term.enter();
    this.running = true;
    this.status = this.client
      ? "Welcome to Billie. Press h for help."
      : "No Congress.gov API key configured — press i to add one.";
    this.render();
    try {
      for await (const key of this.term.keys()) {
        this.handleKey(key);
        if (!this.running) break;
        this.render();
      }
    } finally {
      this.running = false;
      this.pending?.abort();
      this.term.exit();
    }
  }

  private quit(): void {
    this.running = false;
  }

  private pushView(view: ViewName): void {
    this.history.push(this.view);
    this.view = view;
  }

  private back(): void {
    if (this.pending && this.loading) {
      this.pending.abort();
      this.loading = null;
      this.status = "Cancelled.";
      return;
    }
    this.view = this.history.pop() ?? "menu";
  }

  private reset(): void {
    this.history = [];
    this.view = "menu";
    this.results = [];
    this.selected = 0;
    this.detail = null;
    this.detailMode = "overview";
    this.compareMode = "overview";
    this.billTexts.clear();
    this.textErrors.clear();
    this.comparison = null;
    this.analysis = null;
    this.analysisBill = null;
    this.analysisComparison = null;
    this.analysisQuestion = "";
    this.marked.clear();
    this.clearFind();
    this.scroll = 0;
    this.input = "";
    this.status = "Selection cleared.";
  }

  private clearFind(): void {
    this.findQuery = "";
    this.findHits = [];
    this.findIndex = -1;
    this.pendingFindQuery = null;
  }

  private handleKey(key: Key): void {
    if (key.kind === "ctrl" && key.value === "c") {
      this.quit();
      return;
    }
    if (this.view === "config") {
      this.handleConfigMenu(key);
      return;
    }
    if (this.view === "export") {
      this.handleExportMenu(key);
      return;
    }
    if (this.view === "modelPick") {
      this.handleModelPick(key);
      return;
    }
    if (INPUT_VIEWS.has(this.view)) {
      this.handleInput(key);
      return;
    }
    switch (key.kind) {
      case "escape":
        this.back();
        break;
      case "up":
        this.move(-1);
        break;
      case "down":
        this.move(1);
        break;
      case "left":
        if (this.inTextView()) this.stepFind(-1);
        break;
      case "right":
        if (this.inTextView()) this.stepFind(1);
        break;
      case "pageup":
        this.page(-1);
        break;
      case "pagedown":
        this.page(1);
        break;
      case "home":
        this.jumpToEdge("start");
        break;
      case "end":
        this.jumpToEdge("end");
        break;
      case "enter":
        this.activate();
        break;
      case "char":
        this.handleCommand(key.value);
        break;
      default:
        break;
    }
  }

  private handleCommand(char: string): void {
    if (char === "G") {
      this.jumpToEdge("end");
      return;
    }
    if (char === "N") {
      this.stepFind(-1);
      return;
    }
    switch (char.toLowerCase()) {
      case "q":
        this.quit();
        break;
      case "h":
        this.view === "help" ? this.back() : this.pushView("help");
        break;
      case "d":
        this.reset();
        break;
      case "z":
        this.back();
        break;
      case "i":
        this.pushView("config");
        break;
      case "s":
        this.beginSearchOrFind();
        break;
      case "n":
        this.stepFind(1);
        break;
      case "j":
        this.move(this.readingView() ? -1 : 1);
        break;
      case "k":
        this.move(this.readingView() ? 1 : -1);
        break;
      case "g":
        this.jumpToEdge("start");
        break;
      case "f":
        this.page(1);
        break;
      case "v":
        if (this.readingView()) this.page(-1);
        else this.activate();
        break;
      case "w":
        this.openExportMenu();
        break;
      case "m":
        this.toggleMark();
        break;
      case "c":
        this.compareMarked();
        break;
      case "a":
        this.startAnalysis();
        break;
      case "t":
        this.cycleTypeFilter();
        break;
      case "x":
        this.toggleTextMode();
        break;
      default:
        break;
    }
    if (char === " ") this.toggleMark();
    else if (char === "," || char === ".") {
      if (this.inTextView()) this.stepFind(char === "," ? -1 : 1);
      else this.shiftCongress(char === "," ? -1 : 1);
    } else if (char === "<") this.shiftCongress(-1);
    else if (char === ">") this.shiftCongress(1);
  }

  private readingView(): boolean {
    return this.view === "detail" || this.view === "compare" || this.view === "analysis";
  }

  private pageSize(): number {
    const { rows } = Deno.consoleSize();
    return Math.max(1, rows - 8);
  }

  private move(delta: number): void {
    if (this.view === "results" && this.results.length > 0) {
      this.selected = Math.min(this.results.length - 1, Math.max(0, this.selected + delta));
    } else if (this.readingView()) {
      this.scroll = Math.max(0, this.scroll + delta);
    }
  }

  private page(direction: -1 | 1): void {
    if (this.view === "results" && this.results.length > 0) {
      this.selected = Math.min(
        this.results.length - 1,
        Math.max(0, this.selected + direction * this.pageSize()),
      );
      return;
    }
    if (this.readingView()) this.scroll = Math.max(0, this.scroll + direction * this.pageSize());
  }

  private jumpToEdge(edge: "start" | "end"): void {
    if (this.view === "results" && this.results.length > 0) {
      this.selected = edge === "start" ? 0 : this.results.length - 1;
      return;
    }
    if (!this.readingView()) return;
    if (edge === "start") {
      this.scroll = 0;
      return;
    }
    this.scroll = 0;
    const { columns } = Deno.consoleSize();
    const lines = this.viewLines(Math.max(40, columns - 2));
    this.scroll = Math.max(0, lines.length - this.pageSize());
  }

  private activate(): void {
    if (this.view === "results" && this.results[this.selected]) {
      this.openDetail(this.results[this.selected]);
    }
  }

  // ----- configuration menu -----

  private handleConfigMenu(key: Key): void {
    if (key.kind === "escape") {
      this.back();
      return;
    }
    if (key.kind !== "char") return;
    switch (key.value.toLowerCase()) {
      case "c":
        this.beginConfigEdit("congressApiKey", "");
        break;
      case "k":
        this.beginConfigEdit("aiApiKey", "");
        break;
      case "m":
        this.beginConfigEdit("aiModel", this.config.aiModel);
        break;
      case "l":
        this.fetchModelList();
        break;
      case "b":
        this.beginConfigEdit("aiBaseUrl", this.config.aiBaseUrl);
        break;
      default:
        break;
    }
  }

  /** Ask the configured AI endpoint for its advertised model list and offer a picker. */
  private fetchModelList(): void {
    const provider = new OpenAiCompatProvider({
      apiKey: this.config.aiApiKey ?? "",
      model: this.config.aiModel,
      baseUrl: this.config.aiBaseUrl,
      timeoutMs: this.config.requestTimeoutMs,
    });
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    this.loading = `Fetching model list from ${this.config.aiBaseUrl}…`;
    this.render();
    provider
      .listModels(controller.signal)
      .then((models) => {
        if (controller.signal.aborted || !this.running) return;
        this.loading = null;
        if (models.length === 0) {
          this.status = "Endpoint advertised no models.";
          return;
        }
        this.availableModels = models;
        const current = models.indexOf(this.config.aiModel);
        this.modelSelection = current >= 0 ? current : 0;
        this.pushView("modelPick");
        this.status = "Select a model, Enter to save, Esc to cancel.";
      })
      .catch((error: Error) => {
        if (!this.running) return;
        this.loading = null;
        this.status = controller.signal.aborted
          ? "Cancelled."
          : `Model detection failed: ${error.message}`;
      })
      .finally(() => {
        if (this.running) this.render();
      });
  }

  private handleModelPick(key: Key): void {
    if (key.kind === "escape") {
      this.back();
      return;
    }
    if (key.kind === "up" || (key.kind === "char" && key.value === "k")) {
      this.modelSelection = Math.max(0, this.modelSelection - 1);
      return;
    }
    if (key.kind === "down" || (key.kind === "char" && key.value === "j")) {
      this.modelSelection = Math.min(this.availableModels.length - 1, this.modelSelection + 1);
      return;
    }
    if (key.kind === "enter") {
      const model = this.availableModels[this.modelSelection];
      if (!model) return;
      this.configField = "aiModel";
      this.saveConfigField(model);
    }
  }

  private handleExportMenu(key: Key): void {
    if (key.kind === "escape") {
      this.back();
      return;
    }
    if (key.kind === "up") {
      this.exportMenuSelection = Math.max(0, this.exportMenuSelection - 1);
      return;
    }
    if (key.kind === "down") {
      this.exportMenuSelection = Math.min(4, this.exportMenuSelection + 1);
      return;
    }
    if (key.kind === "left" || key.kind === "right") {
      this.cycleExportOption(key.kind === "right" ? 1 : -1);
      return;
    }
    if (key.kind === "enter") {
      if (this.exportMenuSelection === 3) this.beginExportPathEdit();
      else if (this.exportMenuSelection === 4) this.performExport();
      else this.cycleExportOption(1);
      return;
    }
    if (key.kind !== "char") return;
    switch (key.value.toLowerCase()) {
      case "d":
        this.beginExportPathEdit();
        break;
      case "e":
        this.performExport();
        break;
      default:
        break;
    }
  }

  private cycleExportOption(direction: -1 | 1): void {
    if (this.exportMenuSelection === 0) {
      this.exportType = EXPORT_TYPES[
        (EXPORT_TYPES.indexOf(this.exportType) + direction + EXPORT_TYPES.length) %
        EXPORT_TYPES.length
      ];
    } else if (this.exportMenuSelection === 1) {
      this.exportStyle = EXPORT_STYLES[
        (EXPORT_STYLES.indexOf(this.exportStyle) + direction + EXPORT_STYLES.length) %
        EXPORT_STYLES.length
      ];
    } else if (this.exportMenuSelection === 2) {
      this.exportScope = EXPORT_SCOPES[
        (EXPORT_SCOPES.indexOf(this.exportScope) + direction + EXPORT_SCOPES.length) %
        EXPORT_SCOPES.length
      ];
    }
  }

  private beginExportPathEdit(): void {
    this.input = this.config.exportDir;
    this.pushView("exportPathEdit");
  }

  private saveExportPath(value: string): void {
    if (!value) {
      this.status = "Export directory unchanged.";
      this.back();
      return;
    }
    const path = expandHomePath(value);
    saveExportDir(path)
      .then((configFile) => {
        this.config = { ...this.config, exportDir: path };
        this.status = `Export directory saved to ${configFile}.`;
      })
      .catch((error: Error) => {
        this.status = `Could not save export directory: ${error.message}`;
      })
      .finally(() => {
        this.back();
        if (this.running) this.render();
      });
  }

  private beginConfigEdit(field: ConfigField, prefill: string): void {
    this.configField = field;
    this.input = prefill;
    this.pushView("configEdit");
  }

  private saveConfigField(value: string): void {
    const field = this.configField;
    this.configField = null;
    if (!field) {
      this.back();
      return;
    }
    if (value.length === 0) {
      this.status = "No value entered.";
      this.back();
      return;
    }
    const persist = field === "congressApiKey"
      ? saveCongressApiKey(value)
      : field === "aiApiKey"
      ? saveAiApiKey(value)
      : field === "aiModel"
      ? saveAiModel(value)
      : saveAiBaseUrl(value);
    persist
      .then((path) => {
        this.config = { ...this.config, [field]: value };
        this.resetClient();
        this.status = `Saved ${CONFIG_FIELD_LABELS[field]} to ${path}.`;
      })
      .catch((error: Error) => {
        this.status = `Could not save ${CONFIG_FIELD_LABELS[field]}: ${error.message}`;
      })
      .finally(() => {
        this.back();
        if (this.running) this.render();
      });
  }

  // ----- free-text input (search, config edit) -----

  private handleInput(key: Key): void {
    switch (key.kind) {
      case "escape":
        this.input = "";
        this.configField = null;
        this.back();
        break;
      case "enter": {
        const value = this.input.trim();
        const origin = this.view;
        this.input = "";
        if (origin === "configEdit") {
          this.saveConfigField(value);
        } else if (origin === "exportPathEdit") {
          this.saveExportPath(value);
        } else if (origin === "find") {
          this.back();
          if (value.length > 0) {
            if (this.displayedTextsReady()) this.applyFind(value);
            else {
              this.pendingFindQuery = value;
              this.status = "Bill text is still loading; search will start when it is ready.";
            }
          } else this.status = "Find cancelled.";
        } else if (origin === "analysisQuery") {
          this.back();
          if (value.length > 0) this.startComparisonAnalysis(value);
          else this.status = "Comparison analysis cancelled.";
        } else if (value.length > 0) {
          this.back();
          this.startSearch(value);
        } else {
          this.back();
        }
        break;
      }
      case "backspace":
        this.input = [...this.input].slice(0, -1).join("");
        break;
      case "char":
        this.input += key.value;
        break;
      default:
        break;
    }
  }

  // ----- in-document find -----

  private inTextView(): boolean {
    return (this.view === "detail" && this.detailMode === "text") ||
      (this.view === "compare" && this.compareMode === "text");
  }

  private beginSearchOrFind(): void {
    if (this.view === "compare" && this.comparison && this.compareMode === "overview") {
      this.toggleCompareText();
    }
    if (!this.inTextView()) {
      this.input = "";
      this.pushView("search");
      return;
    }
    this.input = this.findQuery;
    this.pushView("find");
  }

  private displayedTexts(): string[] {
    if (this.view === "detail" && this.detail) {
      return [this.billTexts.get(this.refKey(this.detail))?.text ?? ""];
    }
    if (this.view === "compare" && this.comparison) {
      return [
        this.billTexts.get(this.refKey(this.comparison.a))?.text ?? "",
        this.billTexts.get(this.refKey(this.comparison.b))?.text ?? "",
      ];
    }
    return [];
  }

  private displayedTextsReady(): boolean {
    if (this.view === "detail" && this.detail) {
      return this.billTexts.has(this.refKey(this.detail));
    }
    if (this.view === "compare" && this.comparison) {
      return this.billTexts.has(this.refKey(this.comparison.a)) &&
        this.billTexts.has(this.refKey(this.comparison.b));
    }
    return false;
  }

  private applyFind(query: string): void {
    this.pendingFindQuery = null;
    this.findQuery = query;
    this.findHits = findInTexts(this.displayedTexts(), query);
    this.findIndex = -1;
    if (this.findHits.length === 0) {
      this.status = `No matches for “${query}”.`;
      return;
    }
    this.stepFind(1);
  }

  private findScreenRow(hit: FindHit): number {
    const width = Math.max(40, Deno.consoleSize().columns - 2);
    if (this.view === "detail" && this.detail) {
      const text = this.billTexts.get(this.refKey(this.detail));
      const sourceLines = text?.text.split("\n") ?? [];
      const headerRows = 1 + wrap(`Source: ${text?.sourceUrl ?? ""}`, width, "  ").length + 1;
      let row = headerRows;
      for (let i = 0; i < hit.line && i < sourceLines.length; i++) {
        row += Math.max(1, wrap(sourceLines[i], width, "  ").length);
      }
      return row;
    }
    return 3 + hit.line;
  }

  private stepFind(delta: number): void {
    if (!this.inTextView() || this.findHits.length === 0) {
      if (this.inTextView()) this.status = "No active find — press s to search this text.";
      return;
    }
    this.findIndex = stepHit(this.findHits.length, this.findIndex, delta);
    const hit = this.findHits[this.findIndex];
    this.scroll = this.findScreenRow(hit);
    const side = this.view === "compare" ? (hit.side === 0 ? "left" : "right") : "text";
    this.status = `Match ${
      this.findIndex + 1
    }/${this.findHits.length} for “${this.findQuery}” (${side}, line ${
      hit.line + 1
    }). n / N next and previous.`;
  }

  // ----- search -----

  private startSearch(query: string): void {
    if (!this.client) {
      this.status = "No Congress.gov API key configured — press i to add one.";
      return;
    }
    this.lastQuery = query;
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    const filterLabel = this.filterType ? ` [${this.filterType.toUpperCase()}]` : "";
    this.loading = `Searching “${query}” in the ${this.filterCongress}th Congress${filterLabel}…`;
    this.render();
    this.client.searchBills(query, controller.signal, {
      congress: this.filterCongress,
      type: this.filterType,
    })
      .then((bills) => {
        if (controller.signal.aborted || !this.running) return;
        this.loading = null;
        if (bills.length === 0) {
          this.status =
            "No matching bills found. Try different keywords, a bill number like “hr5676”, " +
            "or part of a sponsor’s name.";
          return;
        }
        this.results = bills;
        this.selected = 0;
        if (this.view !== "results") this.pushView("results");
        this.status = `${bills.length} result(s).`;
      })
      .catch((error: Error) => {
        if (!this.running) return;
        this.loading = null;
        this.status = controller.signal.aborted ? "Cancelled." : `Error: ${error.message}`;
      })
      .finally(() => {
        if (this.running) this.render();
      });
  }

  private refKey(ref: { congress: number; type: string; number: number }): string {
    return `${ref.congress}-${ref.type}-${ref.number}`;
  }

  private toggleMark(): void {
    if (this.view !== "results") return;
    const bill = this.results[this.selected];
    if (!bill) return;
    const key = this.refKey(bill);
    if (this.marked.has(key)) {
      this.marked.delete(key);
      this.status = `Unmarked ${billLabel(bill)}.`;
    } else if (this.marked.size >= 2) {
      this.status = "Only two bills can be marked for comparison.";
    } else {
      this.marked.set(key, bill);
      this.status = `Marked ${billLabel(bill)} (${this.marked.size}/2).`;
    }
  }

  private cycleTypeFilter(): void {
    if (this.view !== "results") return;
    const index = BILL_TYPE_FILTERS.indexOf(this.filterType);
    this.filterType = BILL_TYPE_FILTERS[(index + 1) % BILL_TYPE_FILTERS.length];
    this.status = `Type filter: ${this.filterType?.toUpperCase() ?? "all"}.`;
    if (this.lastQuery) this.startSearch(this.lastQuery);
  }

  private shiftCongress(delta: number): void {
    if (this.view !== "results") return;
    this.filterCongress = Math.max(1, this.filterCongress + delta);
    this.status = `Congress: ${this.filterCongress}th.`;
    if (this.lastQuery) this.startSearch(this.lastQuery);
  }

  // ----- comparison -----

  private compareMarked(): void {
    if (!this.client) return;
    if (this.marked.size !== 2) {
      this.status = "Mark two bills in the results list with Space/m, then press c.";
      return;
    }
    const [a, b] = [...this.marked.values()];
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    this.loading = `Fetching ${billLabel(a)} and ${billLabel(b)}…`;
    this.render();
    Promise.all([
      this.client.getBillDetail(a, controller.signal),
      this.client.getBillDetail(b, controller.signal),
    ])
      .then(([detailA, detailB]) => {
        if (controller.signal.aborted || !this.running) return;
        this.loading = null;
        this.comparison = compareBills(detailA, detailB);
        this.compareMode = "overview";
        this.scroll = 0;
        if (this.view !== "compare") this.pushView("compare");
        this.status = "Comparison ready — x side-by-side text · w export.";
      })
      .catch((error: Error) => {
        if (!this.running) return;
        this.loading = null;
        this.status = controller.signal.aborted ? "Cancelled." : `Error: ${error.message}`;
      })
      .finally(() => {
        if (this.running) this.render();
      });
  }

  // ----- AI analysis -----

  private startAnalysis(): void {
    if (this.view === "compare" && this.comparison) {
      if (!this.provider) {
        this.status = "No AI provider configured — press i to add an AI API key.";
        return;
      }
      this.input = "How do these bills differ?";
      this.pushView("analysisQuery");
      return;
    }
    if (this.view !== "detail" || !this.detail) {
      this.status = "Open a bill first, then press a to analyze it.";
      return;
    }
    if (!this.provider) {
      this.status = "No AI provider configured — press i to add an AI API key.";
      return;
    }
    const bill = this.detail;
    const provider = this.provider;
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    this.loading = `Fetching bill text for ${billLabel(bill)}…`;
    this.render();
    const cachedText = this.billTexts.get(this.refKey(bill));
    const textRequest = cachedText
      ? Promise.resolve(cachedText)
      : this.client
      ? this.client.getBillText(bill, controller.signal)
      : Promise.reject(new Error("Congress.gov client is unavailable."));
    textRequest
      .then((billText) => {
        if (controller.signal.aborted || !this.running) return null;
        this.billTexts.set(this.refKey(bill), billText);
        this.loading = `Analyzing ${billLabel(bill)} with ${provider.model}…`;
        this.render();
        return provider.analyze(bill, billText, controller.signal);
      })
      .then((result) => {
        if (!result) return;
        if (controller.signal.aborted || !this.running) return;
        this.loading = null;
        this.analysis = { result, model: provider.model };
        this.analysisBill = bill;
        this.analysisComparison = null;
        this.analysisQuestion = "";
        this.scroll = 0;
        this.pushView("analysis");
        this.status = "Generated interpretation, not authoritative — press w to export.";
      })
      .catch((error: Error) => {
        if (!this.running) return;
        this.loading = null;
        this.status = controller.signal.aborted
          ? "Cancelled."
          : `Analysis failed: ${error.message}`;
      })
      .finally(() => {
        if (this.running) this.render();
      });
  }

  private startComparisonAnalysis(question: string): void {
    if (!this.comparison || !this.provider) return;
    const comparison = this.comparison;
    const provider = this.provider;
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    this.loading = `Fetching text for ${billLabel(comparison.a)} and ${billLabel(comparison.b)}…`;
    this.render();
    const getText = (bill: BillDetail): Promise<BillText> => {
      const cached = this.billTexts.get(this.refKey(bill));
      if (cached) return Promise.resolve(cached);
      if (!this.client) return Promise.reject(new Error("Congress.gov client is unavailable."));
      return this.client.getBillText(bill, controller.signal);
    };
    Promise.all([getText(comparison.a), getText(comparison.b)])
      .then(([textA, textB]) => {
        if (controller.signal.aborted || !this.running) return null;
        this.billTexts.set(this.refKey(comparison.a), textA);
        this.billTexts.set(this.refKey(comparison.b), textB);
        this.loading = `Comparing both bill texts with ${provider.model}…`;
        this.render();
        return provider.analyzeComparison(comparison, question, textA, textB, controller.signal);
      })
      .then((result) => {
        if (!result) return;
        if (controller.signal.aborted || !this.running) return;
        this.loading = null;
        this.analysis = { result, model: provider.model };
        this.analysisBill = null;
        this.analysisComparison = comparison;
        this.analysisQuestion = question;
        this.scroll = 0;
        this.pushView("analysis");
        this.status =
          "Generated comparison using both bill texts and record history — press w to export.";
      })
      .catch((error: Error) => {
        if (!this.running) return;
        this.loading = null;
        this.status = controller.signal.aborted
          ? "Cancelled."
          : `Comparison analysis failed: ${error.message}`;
      })
      .finally(() => {
        if (this.running) this.render();
      });
  }

  // ----- bill detail and verbatim text -----

  private openDetail(summary: BillSummary): void {
    if (!this.client) return;
    this.pending?.abort();
    const controller = new AbortController();
    this.pending = controller;
    this.loading = `Fetching ${summary.type.toUpperCase()} ${summary.number}…`;
    this.render();
    this.client.getBillDetail(summary, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted || !this.running) return;
        this.loading = null;
        this.setDetail(detail);
      })
      .catch((error: Error) => {
        if (!this.running) return;
        this.loading = null;
        this.status = controller.signal.aborted ? "Cancelled." : `Error: ${error.message}`;
      })
      .finally(() => {
        if (this.running) this.render();
      });
  }

  private setDetail(detail: BillDetail): void {
    this.detail = detail;
    this.detailMode = "overview";
    this.scroll = 0;
    if (this.view !== "detail") this.pushView("detail");
    this.status = `${detail.type.toUpperCase()} ${detail.number} — w export · a analyze · x text`;
  }

  private toggleTextMode(): void {
    if (this.view === "detail" && this.detail) {
      this.toggleDetailText();
      return;
    }
    if (this.view === "compare" && this.comparison) {
      this.toggleCompareText();
      return;
    }
    this.status = "Open a bill or a comparison, then press x for verbatim text.";
  }

  private toggleDetailText(): void {
    if (!this.detail) return;
    this.detailMode = this.detailMode === "overview" ? "text" : "overview";
    this.scroll = 0;
    this.clearFind();
    if (this.detailMode === "text") {
      this.ensureBillText(this.detail);
      this.status = "Verbatim text — press w to export, x to return to overview.";
    } else {
      this.status = `${this.detail.type.toUpperCase()} ${this.detail.number} — overview`;
    }
  }

  private toggleCompareText(): void {
    if (!this.comparison) return;
    this.compareMode = this.compareMode === "overview" ? "text" : "overview";
    this.scroll = 0;
    this.clearFind();
    if (this.compareMode === "text") {
      this.ensureBillText(this.comparison.a);
      this.ensureBillText(this.comparison.b);
      this.status = "Side-by-side verbatim text — x returns to the metadata comparison.";
    } else {
      this.status = "Metadata comparison — x side-by-side text · w export.";
    }
  }

  private ensureBillText(bill: BillDetail): void {
    const key = this.refKey(bill);
    if (this.billTexts.has(key) || this.textErrors.has(key) || !this.client) return;
    const controller = new AbortController();
    this.client.getBillText(bill, controller.signal)
      .then((text) => {
        if (controller.signal.aborted || !this.running) return;
        this.billTexts.set(key, text);
        this.status = this.view === "compare"
          ? "Side-by-side verbatim text — x returns to the metadata comparison."
          : "Verbatim text — press w to export, x to return to overview.";
        if (this.pendingFindQuery && this.displayedTextsReady()) {
          const query = this.pendingFindQuery;
          this.applyFind(query);
        }
      })
      .catch((error: Error) => {
        if (!this.running || controller.signal.aborted) return;
        this.textErrors.set(key, error.message);
        this.status = `Text unavailable for ${billLabel(bill)}: ${error.message}`;
      })
      .finally(() => {
        if (this.running) this.render();
      });
  }

  // ----- export -----

  private openExportMenu(): void {
    let bundle: ExportBundle | null = null;
    let baseName = "";
    if (this.view === "detail" && this.detail) {
      if (this.detailMode === "text") {
        const text = this.billTexts.get(this.refKey(this.detail));
        if (!text) {
          this.status = "Text is still loading; wait for it, then press w.";
          return;
        }
        const markdown = billTextToMarkdown(this.detail, text);
        bundle = {
          title: `${billLabel(this.detail)} verbatim text`,
          data: {
            kind: "bill-text",
            bill: this.detail,
            version: text.versionType,
            date: text.date,
            sourceUrl: text.sourceUrl,
            text: text.text,
          },
          markdown,
          text: markdownToPlainText(markdown),
        };
        baseName = `${this.detail.congress}-${this.detail.type}${this.detail.number}-text`;
      } else {
        const markdown = billToMarkdown(this.detail);
        bundle = {
          title: billLabel(this.detail),
          data: { kind: "bill", bill: this.detail },
          markdown,
          text: markdownToPlainText(markdown),
        };
        baseName = `${this.detail.congress}-${this.detail.type}${this.detail.number}`;
      }
    } else if (this.view === "compare" && this.comparison) {
      const comparison = this.comparison;
      if (this.compareMode === "text") {
        const textA = this.billTexts.get(this.refKey(comparison.a));
        const textB = this.billTexts.get(this.refKey(comparison.b));
        if (!textA || !textB) {
          this.status = "Both texts are still loading; wait for them, then press w.";
          return;
        }
        const markdown = comparisonTextToMarkdown(comparison, textA, textB);
        bundle = {
          title: `Side-by-side text: ${billLabel(comparison.a)} vs ${billLabel(comparison.b)}`,
          data: {
            kind: "comparison-text",
            comparison,
            a: {
              bill: comparison.a,
              version: textA.versionType,
              date: textA.date,
              sourceUrl: textA.sourceUrl,
              text: textA.text,
            },
            b: {
              bill: comparison.b,
              version: textB.versionType,
              date: textB.date,
              sourceUrl: textB.sourceUrl,
              text: textB.text,
            },
          },
          markdown,
          text: markdownToPlainText(markdown),
        };
        baseName =
          `compare-text-${comparison.a.type}${comparison.a.number}-vs-${comparison.b.type}${comparison.b.number}`;
      } else {
        const markdown = comparisonToMarkdown(comparison);
        bundle = {
          title: `Comparison: ${billLabel(comparison.a)} vs ${billLabel(comparison.b)}`,
          data: { kind: "comparison", comparison },
          markdown,
          text: markdownToPlainText(markdown),
        };
        baseName =
          `compare-${comparison.a.type}${comparison.a.number}-vs-${comparison.b.type}${comparison.b.number}`;
      }
    } else if (this.view === "analysis" && this.analysis && this.analysisComparison) {
      const markdown = comparisonAnalysisToMarkdown(
        this.analysis.result,
        this.analysisComparison,
        this.analysisQuestion,
        this.analysis.model,
      );
      bundle = {
        title: `AI comparison: ${billLabel(this.analysisComparison.a)} vs ${
          billLabel(this.analysisComparison.b)
        }`,
        data: {
          kind: "analysis-comparison",
          generatedContent: true,
          model: this.analysis.model,
          question: this.analysisQuestion,
          comparison: this.analysisComparison,
          analysis: this.analysis.result,
        },
        markdown,
        text: markdownToPlainText(markdown),
      };
      baseName =
        `analysis-compare-${this.analysisComparison.a.type}${this.analysisComparison.a.number}-vs-${this.analysisComparison.b.type}${this.analysisComparison.b.number}`;
    } else if (this.view === "analysis" && this.analysis && this.analysisBill) {
      const markdown = analysisToMarkdown(
        this.analysis.result,
        this.analysisBill,
        this.analysis.model,
      );
      bundle = {
        title: `AI analysis: ${billLabel(this.analysisBill)}`,
        data: {
          kind: "analysis",
          generatedContent: true,
          model: this.analysis.model,
          bill: this.analysisBill,
          analysis: this.analysis.result,
        },
        markdown,
        text: markdownToPlainText(markdown),
      };
      baseName =
        `analysis-${this.analysisBill.congress}-${this.analysisBill.type}${this.analysisBill.number}`;
    }
    if (!bundle) {
      this.status = "Nothing to export — open a bill, comparison, or analysis first.";
      return;
    }
    const width = Math.max(40, Deno.consoleSize().columns - 2);
    const visibleLines = this.viewLines(width).slice(0, this.pageSize())
      .map((line) => line.replace(/^\s{2}/, ""));
    this.exportContext = { bundle, baseName, visibleLines };
    this.exportMenuSelection = 0;
    this.pushView("export");
    this.status = "Choose export type, style, scope, and destination.";
  }

  private performExport(): void {
    const context = this.exportContext;
    if (!context) return;
    let bundle = context.bundle;
    if (this.exportScope === "view") {
      const visible = context.visibleLines.join("\n");
      bundle = {
        title: `${bundle.title} — current view`,
        data: { kind: "current-view", source: bundle.data, visibleLines: context.visibleLines },
        markdown: `# ${bundle.title} — Current view\n\n` + "```text\n" + visible + "\n```\n",
        text: `${bundle.title}\n\n${visible}\n`,
      };
    }
    this.status = "Exporting…";
    this.render();
    serializeExport(bundle, this.exportType, this.exportStyle)
      .then((content) =>
        writeExport(
          expandHomePath(this.config.exportDir),
          context.baseName,
          this.exportType,
          content,
        )
      )
      .then((path) => this.status = `Wrote ${path}`)
      .catch((error: Error) => this.status = `Export failed: ${error.message}`)
      .finally(() => {
        if (this.running) this.render();
      });
  }

  // ----- rendering -----

  render(): void {
    const { columns } = Deno.consoleSize();
    const width = Math.max(40, columns - 2);
    const lines: string[] = [];
    lines.push(" BILLIE — Congress.gov legislative explorer");
    lines.push(" " + "=".repeat(Math.min(width, 60)));
    lines.push("");
    lines.push(...this.viewLines(width));
    lines.push("", " " + "-".repeat(Math.min(width, 60)));
    lines.push(` ${this.loading ?? this.status}`);
    this.term.render(lines);
  }

  private viewLines(width: number): string[] {
    switch (this.view) {
      case "menu":
        return [
          "   [i] Configure Congress.gov / AI API keys",
          "   [s] Search bills",
          "   [h] Help",
          "   [q] Quit",
          "",
          "   Results: Space/m mark · c compare two marks · t filter type · </> congress",
          "   Bill detail: x verbatim text · a AI analysis (configure key via i) · w export options",
          "   Comparison: x text · a ask AI how the bills differ · w export options",
          "   Long views: PgUp/PgDn or f/v page · b page up · g/G jump to edges",
        ];
      case "config":
        return [
          "  Configuration",
          "",
          `  [c] Congress.gov API key: ${maskSecret(this.config.congressApiKey)}`,
          "      Get a key at https://api.congress.gov/sign-up/",
          "",
          `  [k] AI API key: ${maskSecret(this.config.aiApiKey)}`,
          `  [m] AI model: ${this.config.aiModel}`,
          "  [l] Detect available models from the endpoint",
          `  [b] AI base URL: ${this.config.aiBaseUrl}`,
          "      Works with OpenAI and OpenAI-compatible endpoints; no env vars required.",
          "",
          `  Saved to: ${configPath(Deno.env)}`,
          "",
          "  Press a letter to edit that value, Esc to go back.",
        ];
      case "configEdit": {
        const label = this.configField ? CONFIG_FIELD_LABELS[this.configField] : "value";
        return [
          `  Edit ${label}`,
          "",
          "  Enter to save, Esc to cancel.",
          "",
          `  > ${this.input}█`,
        ];
      }
      case "modelPick": {
        const size = Math.max(5, this.pageSize() - 4);
        const start = Math.min(
          Math.max(0, this.modelSelection - Math.floor(size / 2)),
          Math.max(0, this.availableModels.length - size),
        );
        const windowed = this.availableModels.slice(start, start + size);
        return [
          `  Models advertised by ${this.config.aiBaseUrl}`,
          "",
          ...windowed.map((model, index) =>
            `  ${start + index === this.modelSelection ? ">" : " "} ${model}`
          ),
          "",
          `  ${this.availableModels.length} models · Up/Down or j/k select · Enter save · Esc cancel`,
        ];
      }
      case "export": {
        const entries = [
          `File type: ${this.exportType.toUpperCase()}`,
          `Text style: ${this.exportStyle}`,
          `Scope: ${this.exportScope === "document" ? "entire document" : "current view"}`,
          `Directory: ${this.config.exportDir}`,
          "Export",
        ];
        return [
          "  Export",
          "",
          ...entries.map((entry, index) =>
            `  ${index === this.exportMenuSelection ? ">" : " "} ${entry}`
          ),
          "",
          "  Up/Down select · Left/Right change · Enter edit/activate · d directory · e export · Esc cancel",
        ];
      }
      case "exportPathEdit":
        return [
          "  Export directory",
          "",
          "  Enter a path (~/ expands); Enter saves it for future exports, Esc cancels.",
          "",
          `  > ${this.input}█`,
        ];
      case "find":
        return [
          "  Find in displayed bill text",
          "",
          "  Searches the verbatim text on screen (both columns in a comparison).",
          "  Enter to jump to the first match, n / N for next and previous, Esc to cancel.",
          "",
          `  > ${this.input}█`,
        ];
      case "analysisQuery":
        return [
          "  Ask AI how these bills differ",
          "",
          "  The answer uses available record metadata and action history, not full bill text.",
          "  Enter your question below, press Enter to analyze, or Esc to cancel.",
          "",
          `  > ${this.input}█`,
        ];
      case "search":
        return [
          `  Search bills — ${this.filterCongress}th Congress`,
          "",
          "  Enter keywords, a bill number like “hr5676” / “s 301”, or part of a sponsor’s name.",
          "  (Enter to search, Esc to cancel)",
          "",
          `  > ${this.input}█`,
        ];
      case "results":
        return this.resultLines(width);
      case "detail":
        return this.detailLines(width);
      case "compare":
        return this.compareLines(width);
      case "analysis":
        return this.analysisLines(width);
      case "help":
        return [
          "  Help",
          "",
          "  i  Configure API keys        s  Search bills (find inside text views)",
          "  v  View selected / page up while reading    w  Export options",
          "  c  Compare marked bills      a  Analyze bill / ask comparison question",
          "  In compare mode, a asks about metadata and action differences",
          "  Space/m  Mark for compare    x  Overview / text (side-by-side in compare)",
          "  t  Cycle bill-type filter    < >  Change congress",
          "  ←/,  Previous match           →/.  Next match",
          "  n / N  Next / previous match in displayed text",
          "  PgUp/PgDn or f/v  Page       b  Page up · g/G or Home/End jump to edges",
          "  g/G or Home/End  Jump to start / end",
          "  z  Back (undo)               d  Clear and return to menu",
          "  h  Toggle this help          q  Quit",
          "  ↑/↓ or j/k  Move results · reading: j up / k down    Esc  Back",
        ];
    }
  }

  private resultLines(width: number): string[] {
    const filterLabel = this.filterType ? ` [${this.filterType.toUpperCase()}]` : "";
    const lines = [
      `  Results — ${this.filterCongress}th Congress${filterLabel} (${this.marked.size}/2 marked)`,
      "  ↑/↓ or j/k move · Enter/v open · Space/m mark · c compare · t type · </> congress · " +
      "s new search",
      "",
    ];
    for (const [index, bill] of this.results.entries()) {
      const cursor = index === this.selected ? ">" : " ";
      const mark = this.marked.has(this.refKey(bill)) ? "*" : " ";
      const label = `${bill.type.toUpperCase()}${bill.number}`;
      const title = bill.title.length > width - 12
        ? [...bill.title].slice(0, width - 15).join("") + "…"
        : bill.title;
      lines.push(` ${cursor}${mark} ${label.padEnd(10)} ${title}`);
    }
    return lines;
  }

  private detailLines(width: number): string[] {
    const detail = this.detail;
    if (!detail) return ["  (no bill selected)"];
    if (this.detailMode === "text") return this.billTextLines(detail, width);
    const lines: string[] = [];
    lines.push(`  ${detail.type.toUpperCase()} ${detail.number} — ${detail.congress}th Congress`);
    lines.push(...wrap(detail.title, width, "  "));
    lines.push("");
    lines.push(`  Introduced: ${detail.introducedDate ?? "unavailable"}`);
    lines.push(
      `  Origin: ${detail.originChamber ?? "unavailable"}   Updated: ${
        detail.updateDate || "unavailable"
      }`,
    );
    lines.push(
      `  Cosponsors: ${detail.cosponsorCount ?? "unavailable"}   Policy area: ${
        detail.policyArea ?? "unavailable"
      }`,
    );
    if (detail.sponsors.length > 0) {
      const names = detail.sponsors
        .map((s) =>
          s.name + (s.party || s.state ? ` (${[s.party, s.state].filter(Boolean).join("-")})` : "")
        )
        .join(", ");
      lines.push(...wrap(`Sponsors: ${names}`, width, "  "));
    }
    if (detail.subjects.length > 0) {
      lines.push(...wrap(`Subjects: ${detail.subjects.join(", ")}`, width, "  "));
    }
    if (detail.latestAction) {
      lines.push("");
      lines.push(...wrap(
        `Latest action (${detail.latestAction.date}): ${detail.latestAction.text}`,
        width,
        "  ",
      ));
    }
    if (detail.actions.length > 0) {
      lines.push("", "  Recent actions:");
      for (const action of detail.actions.slice(0, MAX_DETAIL_ACTIONS)) {
        lines.push(...wrap(`${action.date} — ${action.text}`, width, "    "));
      }
      if (detail.actions.length > MAX_DETAIL_ACTIONS) {
        lines.push(`    … ${detail.actions.length - MAX_DETAIL_ACTIONS} more`);
      }
    }
    lines.push("", ...wrap(`Source: ${detail.url || "Congress.gov API"}`, width, "  "));
    return lines.slice(this.scroll);
  }

  private billTextLines(detail: BillDetail, width: number): string[] {
    const cached = this.billTexts.get(this.refKey(detail));
    if (!cached) return ["  Loading verbatim text… (press x to return to overview)"];
    const active = this.findHits[this.findIndex];
    const body = cached.text.split("\n").flatMap((line, index) => {
      const wrapped = wrap(line, width, "  ");
      if (active && active.side === 0 && active.line === index) {
        wrapped[0] = `>${wrapped[0].slice(1)}`;
      }
      return wrapped;
    });
    const lines = [
      `  ${billLabel(detail)} — ${cached.versionType}${cached.date ? ` (${cached.date})` : ""}`,
      ...wrap(`Source: ${cached.sourceUrl}`, width, "  "),
      "",
      ...body,
    ];
    return lines.slice(this.scroll);
  }

  private compareLines(width: number): string[] {
    const comparison = this.comparison;
    if (!comparison) return ["  (no comparison loaded)"];
    if (this.compareMode === "text") return this.compareTextLines(comparison, width);
    const labelA = billLabel(comparison.a);
    const labelB = billLabel(comparison.b);
    const lines = [`  Comparing ${labelA} vs ${labelB}`, ""];
    for (const row of comparison.rows) {
      if (row.differs) {
        lines.push(...wrap(`≠ ${row.label}:`, width, "  "));
        lines.push(...wrap(`A: ${row.a}`, width, "    "));
        lines.push(...wrap(`B: ${row.b}`, width, "    "));
      } else {
        lines.push(...wrap(`= ${row.label}: ${row.a}`, width, "  "));
      }
    }
    lines.push("", `  Actions: ${comparison.actions.common.length} shared`);
    if (comparison.actions.onlyA.length > 0) {
      lines.push(`  Only in ${labelA}:`);
      for (const action of comparison.actions.onlyA) {
        lines.push(...wrap(`- ${action}`, width, "    "));
      }
    }
    if (comparison.actions.onlyB.length > 0) {
      lines.push(`  Only in ${labelB}:`);
      for (const action of comparison.actions.onlyB) {
        lines.push(...wrap(`- ${action}`, width, "    "));
      }
    }
    lines.push("", "  Press x for side-by-side verbatim text, or a to ask AI how they differ.");
    return lines.slice(this.scroll);
  }

  private compareTextLines(comparison: BillComparison, width: number): string[] {
    const textA = this.billTexts.get(this.refKey(comparison.a));
    const textB = this.billTexts.get(this.refKey(comparison.b));
    const header = pairColumns(
      this.textHeading(comparison.a, textA),
      this.textHeading(comparison.b, textB),
      width,
    );
    const hint = truncate(
      "  s find · ←/, previous · →/. next · b bottom · PgUp/PgDn page · x metadata · w export",
      width,
    );
    return [
      header,
      hint,
      pairColumns("-".repeat(width), "-".repeat(width), width),
      ...sideBySide(
        this.textColumn(comparison.a, textA, 0),
        this.textColumn(comparison.b, textB, 1),
        width,
      ),
    ].slice(this.scroll);
  }

  private textHeading(bill: BillDetail, text: BillText | undefined): string {
    const version = text ? ` — ${text.versionType}${text.date ? ` (${text.date})` : ""}` : "";
    return `${billLabel(bill)}${version}`;
  }

  private textColumn(bill: BillDetail, text: BillText | undefined, side: 0 | 1): string[] {
    if (text) {
      const active = this.findHits[this.findIndex];
      return text.text.split("\n").map((line, index) =>
        active && active.side === side && active.line === index ? `> ${line}` : line
      );
    }
    const error = this.textErrors.get(this.refKey(bill));
    return [error ? `Text unavailable: ${error}` : "Loading verbatim text…"];
  }

  private analysisLines(width: number): string[] {
    const analysis = this.analysis;
    const bill = this.analysisBill;
    const comparison = this.analysisComparison;
    if (!analysis || (!bill && !comparison)) return ["  (no analysis loaded)"];
    const lines = [
      comparison
        ? `  AI comparison: ${billLabel(comparison.a)} vs ${billLabel(comparison.b)}`
        : `  AI analysis of ${billLabel(bill!)}`,
      `  Generated by ${analysis.model} — an interpretation, not the authoritative record.`,
      ...(comparison ? wrap(`Question: ${this.analysisQuestion}`, width, "  ") : []),
      ...(comparison
        ? wrap(
          "Based on record metadata and action history; full bill text was not supplied.",
          width,
          "  ",
        )
        : []),
      "",
      ...wrap(analysis.result.summary, width, "  "),
    ];
    const section = (title: string, items: string[]): void => {
      if (items.length === 0) return;
      lines.push("", `  ${title}:`);
      for (const item of items) lines.push(...wrap(`- ${item}`, width, "    "));
    };
    section(comparison ? "Key differences" : "Key provisions", analysis.result.keyProvisions);
    section("Affected parties", analysis.result.affectedParties);
    section("Uncertainties", analysis.result.uncertainties);
    if (comparison) {
      lines.push("", ...wrap(`Source A: ${comparison.a.url || "Congress.gov API"}`, width, "  "));
      lines.push(...wrap(`Source B: ${comparison.b.url || "Congress.gov API"}`, width, "  "));
    } else {
      lines.push("", ...wrap(`Source: ${bill!.url || "Congress.gov API"}`, width, "  "));
    }
    return lines.slice(this.scroll);
  }
}
