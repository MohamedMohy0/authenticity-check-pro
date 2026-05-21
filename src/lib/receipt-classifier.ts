import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

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

async function getAllText(pdfData: Uint8Array): Promise<string[]> {
  const doc = await pdfjsLib.getDocument({ data: pdfData }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(content.items.map((it: any) => it.str ?? "").join(" "));
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

interface FingerprintResult {
  count: number;
  identical?: boolean;
  status: "Original" | "Modified" | "Unknown";
}

function analyzeFingerprints(bytes: Uint8Array): FingerprintResult {
  const raw = bytesToLatin1(bytes);
  // Match last /ID array in trailer
  const matches = [...raw.matchAll(/\/ID\s*\[\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\]/g)];
  if (matches.length === 0) return { count: 0, status: "Unknown" };
  const last = matches[matches.length - 1];
  const fp1 = last[1].toLowerCase();
  const fp2 = last[2].toLowerCase();
  const identical = fp1 === fp2;
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
  // Page count
  let pages = 0;
  let pageTexts: string[] = [];
  try {
    const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
    pages = doc.numPages;
    pageTexts = await getAllText(pdfBytes.slice());
  } catch {
    pages = 0;
  }

  // Metadata via pdf-lib
  let creator = "";
  let producer = "";
  let creationRaw: string | undefined;
  let modRaw: string | undefined;
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
    creator = pdfDoc.getCreator() || "";
    producer = pdfDoc.getProducer() || "";
    // Raw dates - pdf-lib returns Date; we need original raw to compare equality of strings
    const c = pdfDoc.getCreationDate();
    const m = pdfDoc.getModificationDate();
    creationRaw = c ? `D:${formatPdfDate(c)}` : undefined;
    modRaw = m ? `D:${formatPdfDate(m)}` : undefined;
  } catch {}

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

  // Fingerprint check
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
  if (creator.includes("Canva") || producer.includes("Canva"))
    return { ...base, verdict: "Fake" };

  const isSTC = allText.includes("stc Bank");
  const isABU =
    allText.includes("ﻣﺼﺮف أﺑﻮﻇﺒﻲ اﻟﺈﺳﻼﻣﻲ") || allText.includes("AbuDhabiIslamicBank");
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

  if (producer.includes("GPL") || creator.includes("GPL"))
    return { ...base, verdict: "Fake" };

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
