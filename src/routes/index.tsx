import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import {
  classifyReceipt,
  type ReceiptAnalysis,
} from "@/lib/receipt-classifier";
import { CheckCircle2, XCircle, FileWarning, Upload, Loader2, ShieldCheck, CalendarClock } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "فحص الوصولات | UFRC" },
      { name: "description", content: "تحقق من أصالة وصولات التحويل البنكية بسرعة وأمان." },
    ],
  }),
});

function formatArabicDate(d: Date | string | null): string | null {
  if (!d) return null;
  if (typeof d === "string") return d;
  try {
    return new Intl.DateTimeFormat("ar", {
      dateStyle: "full",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

function Index() {
  const [result, setResult] = useState<ReceiptAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("الرجاء رفع ملف بصيغة PDF فقط");
      return;
    }
    setError(null);
    setResult(null);
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      // Small delay for UX consistency with original
      await new Promise((r) => setTimeout(r, 600));
      const r = await classifyReceipt(buf);
      setResult(r);
    } catch (e) {
      setError("تعذّر قراءة الملف، تأكد من صحته");
    } finally {
      setLoading(false);
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const reset = () => {
    setResult(null);
    setFileName(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <main
      className="relative min-h-screen overflow-hidden px-4 py-8 sm:py-14"
      style={{ background: "var(--gradient-aurora), var(--color-background)" }}
    >
      <div className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background:radial-gradient(circle_at_50%_-10%,oklch(0.7_0.2_265/0.25),transparent_60%)]" />

      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-8 flex flex-col items-center text-center">
          <div
            className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl text-primary-foreground shadow-[var(--shadow-glow)]"
            style={{ background: "var(--gradient-brand)" }}
          >
            <ShieldCheck className="h-8 w-8" strokeWidth={2.2} />
          </div>
          <h1 className="bg-gradient-to-l from-primary to-[oklch(0.7_0.2_200)] bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
            التحقق من وصل التحويل
          </h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            الموقع مدعوم بالكامل من قبل فريق <span className="font-semibold text-foreground">UFRC</span>
          </p>
          <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-warning/15 px-3 py-1 text-xs font-medium text-warning-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            الموقع لا يزال تحت التجربة
          </span>
        </header>

        <section
          className="rounded-3xl border border-border/60 bg-card/80 p-6 backdrop-blur-xl sm:p-8"
          style={{ boxShadow: "var(--shadow-soft)" }}
        >
          {!result && !loading && (
            <label
              htmlFor="pdf-input"
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-all ${
                dragOver
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/60 hover:bg-accent/40"
              }`}
            >
              <div
                className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-primary-foreground transition-transform group-hover:scale-110"
                style={{ background: "var(--gradient-brand)" }}
              >
                <Upload className="h-7 w-7" />
              </div>
              <p className="text-base font-semibold text-foreground sm:text-lg">
                اسحب وأفلت الوصل هنا
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                أو اضغط للاختيار من جهازك — يدعم PDF فقط
              </p>
              <input
                ref={inputRef}
                id="pdf-input"
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </label>
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="mt-4 text-base font-medium">يرجى الانتظار، يتم التحقق من الوصل…</p>
              {fileName && (
                <p className="mt-1 text-xs text-muted-foreground">{fileName}</p>
              )}
            </div>
          )}

          {error && !loading && (
            <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-center text-sm text-destructive">
              {error}
            </div>
          )}

          {result && !loading && (
            <ResultCard result={result} fileName={fileName} onReset={reset} />
          )}
        </section>

        <footer className="mt-8 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} UFRC — جميع الحقوق محفوظة
        </footer>
      </div>
    </main>
  );
}

function ResultCard({
  result,
  fileName,
  onReset,
}: {
  result: ReceiptAnalysis;
  fileName: string | null;
  onReset: () => void;
}) {
  const created = formatArabicDate(result.creationDate);

  const config =
    result.verdict === "Original"
      ? {
          icon: CheckCircle2,
          title: "الوصل سليم",
          subtitle: "تم التحقق من أصالة هذا الوصل بنجاح",
          ringClass: "ring-success/30",
          bgClass: "bg-success/10",
          iconClass: "text-success",
        }
      : result.verdict === "NotReceipt"
        ? {
            icon: FileWarning,
            title: "هذا الملف ليس وصل تحويل",
            subtitle: "الرجاء إدخال ملف وصل تحويل صحيح",
            ringClass: "ring-warning/30",
            bgClass: "bg-warning/10",
            iconClass: "text-warning",
          }
        : {
            icon: XCircle,
            title: "هذا الوصل غير سليم",
            subtitle: "تم اكتشاف تعديلات أو أن الوصل غير أصلي",
            ringClass: "ring-destructive/30",
            bgClass: "bg-destructive/10",
            iconClass: "text-destructive",
          };

  const Icon = config.icon;

  return (
    <div className="flex flex-col items-center text-center">
      <div
        className={`flex h-20 w-20 items-center justify-center rounded-full ring-8 ${config.ringClass} ${config.bgClass}`}
      >
        <Icon className={`h-10 w-10 ${config.iconClass}`} strokeWidth={2.2} />
      </div>
      <h2 className="mt-5 text-2xl font-bold">{config.title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{config.subtitle}</p>

      {fileName && (
        <p className="mt-3 max-w-full truncate rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          {fileName}
        </p>
      )}

      <div className="mt-6 w-full rounded-2xl border border-border/60 bg-accent/40 p-4 text-right">
        <div className="flex items-start gap-3">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="flex-1">
            <p className="text-xs font-medium text-muted-foreground">ملاحظة</p>
            <p className="mt-0.5 text-sm leading-relaxed text-foreground">
              {created
                ? <>تم إنشاء هذا الوصل بتاريخ <span className="font-semibold">{created}</span></>
                : "تاريخ الإنشاء غير متوفر في بيانات الملف"}
            </p>
          </div>
        </div>
      </div>

      <button
        onClick={onReset}
        className="mt-6 inline-flex items-center justify-center rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-[var(--shadow-glow)] transition-transform hover:scale-[1.02] active:scale-[0.98]"
      >
        فحص وصل آخر
      </button>
    </div>
  );
}
