// Lazy imports inside functions to avoid SSR ("DOMMatrix is not defined")

const CREATORS = new Set(["Chromium", "JasperReports Library"]);

export type Verdict = "Original" | "Fake" | "NotReceipt";

export interface ReceiptAnalysis {
  verdict: Verdict;
  creationDate: Date | string | null;
  modDate: Date | string | null;
  creator: string;
  producer: string;
  pages: number;
}

type PdfJsModule = typeof import("pdfjs-dist");
type PdfTextItem = { str?: string };

async function loadPdfjs(): Promise<PdfJsModule> {
  const pdfjsLib = await import("pdfjs-dist");
  const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
  return pdfjsLib;
}

async function getAllText(pdfData: Uint8Array): Promise<string[]> {
  const pdfjsLib = await loadPdfjs();
  const doc = await pdfjsLib.getDocument({ data: pdfData }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(content.items.map((it) => (it as PdfTextItem).str ?? "").join(" "));
  }
  return out;
}

function bytesIndexCount(bytes: Uint8Array, needle: string): number {
  const n = new TextEncoder().encode(needle);
  let count = 0;
  outer: for (let i = 0; i <= bytes.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (bytes[i + j] !== n[j]) continue outer;
    }
    count++;
    i += n.length - 1;
  }
  return count;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + chunk, bytes.length)) as unknown as number[],
    );
  }
  return s;
}

function skipPdfSpace(raw: string, i: number): number {
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "%") {
      while (i < raw.length && raw[i] !== "\n" && raw[i] !== "\r") i++;
      continue;
    }
    if (ch === "\0" || ch === "\t" || ch === "\n" || ch === "\f" || ch === "\r" || ch === " ") {
      i++;
      continue;
    }
    break;
  }
  return i;
}

function hexToLatin1(hex: string): string {
  const normalized = hex.replace(/\s+/g, "").toLowerCase();
  const padded = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  let out = "";
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  }
  return out;
}

function parsePdfStringToken(raw: string, start: number): { value: string; next: number } | null {
  let i = skipPdfSpace(raw, start);

  if (raw[i] === "<" && raw[i + 1] !== "<") {
    i++;
    let value = "";
    while (i < raw.length && raw[i] !== ">") {
      value += raw[i];
      i++;
    }
    return raw[i] === ">" ? { value: hexToLatin1(value), next: i + 1 } : null;
  }

  if (raw[i] === "(") {
    i++;
    let depth = 1;
    let value = "";
    while (i < raw.length && depth > 0) {
      const ch = raw[i];
      if (ch === "\\") {
        const next = raw[i + 1] ?? "";
        const octal = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0];
        if (octal) {
          value += String.fromCharCode(parseInt(octal, 8));
          i += 1 + octal.length;
          continue;
        }
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        if (next === "\r" || next === "\n") {
          i += next === "\r" && raw[i + 2] === "\n" ? 3 : 2;
          continue;
        }
        value += escapes[next] ?? next;
        i += 2;
        continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (depth > 0) value += ch;
      i++;
    }
    return depth === 0 ? { value: `(${value})`, next: i } : null;
  }

  return null;
}

function parseIdArrayAt(raw: string, idIndex: number): { a: string; b: string } | null {
  let i = skipPdfSpace(raw, idIndex + 3);
  if (raw[i] !== "[") return null;
  i++;
  const first = parsePdfStringToken(raw, i);
  if (!first) return null;
  const second = parsePdfStringToken(raw, first.next);
  if (!second) return null;
  return { a: first.value, b: second.value };
}

function extractTrailerIds(raw: string): Array<{ index: number; a: string; b: string }> {
  const ids: Array<{ index: number; a: string; b: string }> = [];
  const startXrefMatches = [...raw.matchAll(/startxref\s+(\d+)/g)];

  for (const match of startXrefMatches) {
    const offset = Number(match[1]);
    if (!Number.isFinite(offset) || offset < 0 || offset >= raw.length) continue;
    const window = raw.slice(offset, Math.min(raw.length, offset + 6000));
    const localId = window.indexOf("/ID");
    if (localId === -1) continue;
    const parsed = parseIdArrayAt(window, localId);
    if (parsed) ids.push({ index: offset + localId, ...parsed });
  }

  for (const match of raw.matchAll(/\btrailer\b/g)) {
    const local = raw.slice(match.index ?? 0, Math.min(raw.length, (match.index ?? 0) + 6000));
    const localId = local.indexOf("/ID");
    if (localId === -1) continue;
    const parsed = parseIdArrayAt(local, localId);
    if (parsed) ids.push({ index: (match.index ?? 0) + localId, ...parsed });
  }

  if (ids.length === 0) {
    for (const match of raw.matchAll(/\/ID\b/g)) {
      const parsed = parseIdArrayAt(raw, match.index ?? 0);
      if (parsed) ids.push({ index: match.index ?? 0, ...parsed });
    }
  }

  return ids;
}

interface FingerprintResult {
  count: number;
  identical?: boolean;
  status: "Original" | "Modified" | "Unknown";
}

function analyzeFingerprints(bytes: Uint8Array): FingerprintResult {
  const raw = bytesToLatin1(bytes);
  const all = extractTrailerIds(raw);
  if (all.length === 0) return { count: 0, status: "Unknown" };
  all.sort((x, y) => x.index - y.index);
  const last = all[all.length - 1];
  const identical = last.a === last.b;
  return { count: 2, identical, status: identical ? "Original" : "Modified" };
}

function parsePdfDate(raw: string | undefined | null): Date | string | null {
  if (!raw) return null;
  const s = String(raw);
  if (s.startsWith("D:")) {
    const core = s.slice(2, 16);
    if (core.length >= 14) {
      const y = +core.slice(0, 4);
      const mo = +core.slice(4, 6) - 1;
      const d = +core.slice(6, 8);
      const h = +core.slice(8, 10);
      const mi = +core.slice(10, 12);
      const se = +core.slice(12, 14);
      const dt = new Date(y, mo, d, h, mi, se);
      if (!isNaN(dt.getTime())) return dt;
    }
  }
  return s;
}

function countObjects(bytes: Uint8Array): number {
  const raw = bytesToLatin1(bytes);
  return (raw.match(/\n(\d+)\s+\d+\s+obj/g) || []).length;
}

export async function classifyReceipt(pdfBytes: Uint8Array): Promise<ReceiptAnalysis> {
  const { PDFDocument } = await import("pdf-lib");
  const pdfjsLib = await loadPdfjs();

  let pages = 0;
  let pageTexts: string[] = [];
  try {
    const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
    pages = doc.numPages;
    pageTexts = await getAllText(pdfBytes.slice());
  } catch {
    pages = 0;
  }

  let creator = "";
  let producer = "";
  let creationRaw: string | undefined;
  let modRaw: string | undefined;
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    creator = pdfDoc.getCreator() || "";
    producer = pdfDoc.getProducer() || "";
    const c = pdfDoc.getCreationDate();
    const m = pdfDoc.getModificationDate();
    creationRaw = c ? `D:${formatPdfDate(c)}` : undefined;
    modRaw = m ? `D:${formatPdfDate(m)}` : undefined;
  } catch {
    // Keep matching the original app behavior: unreadable metadata simply falls back to empty values.
  }

  const creationDate = parsePdfDate(creationRaw);
  const modDate = parsePdfDate(modRaw);

  const base: Omit<ReceiptAnalysis, "verdict"> = {
    creationDate,
    modDate,
    creator,
    producer,
    pages,
  };

  if (pages > 1) return { ...base, verdict: "NotReceipt" };

  const fp = analyzeFingerprints(pdfBytes);
  if (fp.status === "Modified") return { ...base, verdict: "Fake" };

  const allText = pageTexts.join("\n");
  const isText = allText.trim().length > 0;
  if (!isText) return { ...base, verdict: "Fake" };

  let creator2 = creator;
  let producer2 = producer;
  if (creator.includes("JasperReports Library") || producer.includes("JasperReports Library")) {
    creator2 = producer2 = "JasperReports Library";
  }
  if (creator.includes("Microsoft Word") || producer.includes("Microsoft Word"))
    return { ...base, verdict: "Fake" };
  if (creator.includes("Canva") || producer.includes("Canva")) return { ...base, verdict: "Fake" };

  const isSTC = allText.includes("stc Bank");
  const isABU = allText.includes("ﻣﺼﺮف أﺑﻮﻇﺒﻲ اﻟﺈﺳﻼﻣﻲ") || allText.includes("AbuDhabiIslamicBank");
  const isQIB = allText.includes("QIB Mobile App");

  if (isSTC) {
    const objs = countObjects(pdfBytes);
    return { ...base, verdict: objs === 11 ? "Original" : "Fake" };
  }
  if (isABU) {
    const objs = countObjects(pdfBytes);
    return { ...base, verdict: objs === 17 ? "Original" : "Fake" };
  }
  if (isQIB) {
    const tables = bytesIndexCount(pdfBytes, "xref");
    return { ...base, verdict: tables === 2 ? "Original" : "Fake" };
  }

  if (producer.includes("GPL") || creator.includes("GPL")) return { ...base, verdict: "Fake" };

  if (!creationDate || !modDate || !creator2 || !producer2 || producer.includes("PDFsharp")) {
    const hasAcro = bytesIndexCount(pdfBytes, "/AcroForm") > 0;
    const eofCount = bytesIndexCount(pdfBytes, "%%EOF");
    const edited = hasAcro || eofCount > 1;
    return { ...base, verdict: edited ? "Fake" : "Original" };
  }

  const sameDates =
    creationDate instanceof Date &&
    modDate instanceof Date &&
    creationDate.getTime() === modDate.getTime();
  if (sameDates && (CREATORS.has(creator2) || CREATORS.has(producer2))) {
    return { ...base, verdict: "Original" };
  }
  return { ...base, verdict: "Fake" };
}

function formatPdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
