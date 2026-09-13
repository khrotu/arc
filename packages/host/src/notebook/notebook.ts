export interface NotebookOutputRaw {
  output_type: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
export interface NotebookCellRaw {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: NotebookOutputRaw[];
}
export interface NotebookDocument {
  cells: NotebookCellRaw[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}
export interface CellSummary {
  index: number;
  cellType: string;
  preview: string;
  hasOutput: boolean;
}
export interface CellOutputSummary {
  text: string;
  images: string[];
}
export interface CellDetail {
  index: number;
  cellType: string;
  source: string;
  output?: CellOutputSummary;
}
export function joinSource(source: string | string[] | undefined): string {
  if (source === undefined) return "";
  return Array.isArray(source) ? source.join("") : source;
}
export function splitSource(text: string): string[] {
  if (!text) return [];
  const parts = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    if (isLast) {
      if (parts[i] !== "") out.push(parts[i]);
    } else {
      out.push(parts[i] + "\n");
    }
  }
  return out;
}
const MAX_NOTEBOOK_BYTES = 8 * 1024 * 1024;
const MAX_CELL_TEXT = 24 * 1024;
const MAX_IMAGES = 8;
export function parseNotebook(raw: string): NotebookDocument {
  if (raw.length > MAX_NOTEBOOK_BYTES) throw new Error(`Notebook too large (${(raw.length / 1048576).toFixed(1)}MB > 8MB).`);
  const doc = JSON.parse(raw) as NotebookDocument;
  if (!doc || !Array.isArray(doc.cells)) throw new Error("Invalid notebook: missing 'cells' array.");
  return doc;
}
export function serializeNotebook(doc: NotebookDocument): string {
  return JSON.stringify(doc, null, 1) + "\n";
}
export function listCells(doc: NotebookDocument): CellSummary[] {
  return doc.cells.map((c, i) => {
    const src = joinSource(c.source);
    const preview = src.length > 120 ? src.slice(0, 119) + "..." : src;
    return { index: i, cellType: c.cell_type, preview, hasOutput: !!(c.outputs && c.outputs.length) };
  });
}
export function summarizeOutputs(outputs: NotebookOutputRaw[] | undefined): CellOutputSummary {
  const textParts: string[] = [];
  const images: string[] = [];
  for (const o of outputs ?? []) {
    if (o.output_type === "stream") {
      textParts.push(joinSource(o.text));
    } else if (o.output_type === "execute_result" || o.output_type === "display_data") {
      const data = o.data ?? {};
      if (data["image/png"]) images.push(`data:image/png;base64,${joinSource(data["image/png"])}`);
      else if (data["image/jpeg"]) images.push(`data:image/jpeg;base64,${joinSource(data["image/jpeg"])}`);
      if (data["text/plain"]) textParts.push(joinSource(data["text/plain"]));
    } else if (o.output_type === "error") {
      textParts.push(`${o.ename ?? "Error"}: ${o.evalue ?? ""}\n${(o.traceback ?? []).join("\n")}`.trim());
    }
  }
  return { text: truncateCellText(textParts.join("\n").trim()), images: images.slice(0, MAX_IMAGES) };
}
function truncateCellText(text: string): string {
  if (text.length <= MAX_CELL_TEXT) return text;
  return `${text.slice(0, MAX_CELL_TEXT)}\n...(output truncated, ${text.length - MAX_CELL_TEXT} more chars)`;
}
function requireCell(doc: NotebookDocument, index: number): NotebookCellRaw {
  const cell = doc.cells[index];
  if (!cell) throw new Error(`Cell index ${index} out of range (notebook has ${doc.cells.length} cell(s)).`);
  return cell;
}
export function readCell(doc: NotebookDocument, index: number): CellDetail {
  const cell = requireCell(doc, index);
  const output = cell.cell_type === "code" ? summarizeOutputs(cell.outputs) : undefined;
  const source = joinSource(cell.source);
  return { index, cellType: cell.cell_type, source: truncateCellText(source), ...(output ? { output } : {}) };
}
export function editCellSource(doc: NotebookDocument, index: number, source: string): NotebookDocument {
  requireCell(doc, index);
  const cells = doc.cells.slice();
  cells[index] = { ...cells[index], source: splitSource(source) };
  return { ...doc, cells };
}
export function addCell(doc: NotebookDocument, index: number, cellType: "code" | "markdown" | "raw", source: string): NotebookDocument {
  const cells = doc.cells.slice();
  const newCell: NotebookCellRaw = {
    cell_type: cellType,
    source: splitSource(source),
    metadata: {},
    ...(cellType === "code" ? { execution_count: null, outputs: [] } : {}),
  };
  const at = Math.max(0, Math.min(index, cells.length));
  cells.splice(at, 0, newCell);
  return { ...doc, cells };
}
export function deleteCell(doc: NotebookDocument, index: number): NotebookDocument {
  requireCell(doc, index);
  const cells = doc.cells.slice();
  cells.splice(index, 1);
  return { ...doc, cells };
}