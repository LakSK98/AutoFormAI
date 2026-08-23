"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Sparkles, Send, CheckCircle, Database, AlertTriangle, FlaskConical } from "lucide-react";
import axios from "axios";

interface ScrapedField {
  name: string;
  title: string;
  type: string;
  pageIndex: number;
  required: boolean;
  options?: string[];
}

interface FormConfig {
  title: string;
  submitUrl: string;
  fields: ScrapedField[];
  pageCount: number;
  hasBranching: boolean;
  warnings: string[];
}

const TYPE_LABELS: Record<string, string> = {
  text: "Short answer",
  textarea: "Paragraph",
  email: "Email",
  radio: "Multiple choice",
  dropdown: "Dropdown",
  checkbox: "Checkboxes",
  linear_scale: "Linear scale",
  rating: "Rating",
  radio_grid: "Grid row",
  checkbox_grid: "Checkbox grid row",
  date: "Date",
  time: "Time",
};

export default function Home() {
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState("");

  const [formConfig, setFormConfig] = useState<FormConfig | null>(null);

  const [context, setContext] = useState("A software developer using the product for a month.");
  const [count, setCount] = useState(5);
  const [timeWindow, setTimeWindow] = useState(2);

  const [isScheduling, setIsScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [scheduleWarnings, setScheduleWarnings] = useState<string[]>([]);

  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; warnings: string[] } | null>(null);

  const typeSummary = useMemo(() => {
    if (!formConfig) return [];
    const counts = new Map<string, number>();
    for (const f of formConfig.fields) {
      counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [formConfig]);

  const requiredCount = formConfig?.fields.filter((f) => f.required).length ?? 0;

  const handleScrape = async () => {
    if (!url) return;
    setIsScraping(true);
    setScrapeError("");
    setTestResult(null);
    try {
      const res = await axios.post<FormConfig>("/api/scrape", { url });
      setFormConfig(res.data);
      setStep(2);
    } catch (err: any) {
      setScrapeError(err.response?.data?.error || "Failed to scrape the form.");
    } finally {
      setIsScraping(false);
    }
  };

  const basePayload = () => ({
    formUrl: formConfig!.submitUrl,
    fields: formConfig!.fields,
    pageCount: formConfig!.pageCount,
    context,
  });

  const handleTest = async () => {
    if (!formConfig) return;
    setIsTesting(true);
    setTestResult(null);
    setScheduleError("");
    try {
      const res = await axios.post("/api/generate-and-schedule", {
        ...basePayload(),
        count: 1,
        mode: "test",
      });
      setTestResult({
        ok: Boolean(res.data.success),
        message: res.data.success
          ? "One real response was submitted and Google confirmed it."
          : res.data.error || "Google did not accept the response.",
        warnings: res.data.warnings ?? [],
      });
    } catch (err: any) {
      setTestResult({
        ok: false,
        message: err.response?.data?.error || "Test submission failed.",
        warnings: err.response?.data?.warnings ?? [],
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSchedule = async () => {
    if (!formConfig) return;
    if (!context.trim()) {
      setScheduleError("Describe the persona before launching.");
      return;
    }

    setIsScheduling(true);
    setScheduleError("");
    setScheduleWarnings([]);
    try {
      const res = await axios.post("/api/generate-and-schedule", {
        ...basePayload(),
        count,
        timeWindowHours: timeWindow,
      });
      setScheduleWarnings(res.data.warnings ?? []);
      setStep(3);
    } catch (err: any) {
      setScheduleError(err.response?.data?.error || "Failed to schedule.");
    } finally {
      setIsScheduling(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute top-20 -left-20 w-96 h-96 bg-blue-500/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-20 -right-20 w-96 h-96 bg-purple-500/20 rounded-full blur-[120px] pointer-events-none" />

      <div className="w-full max-w-4xl z-10">
        <div className="text-center mb-12">
          <motion.div
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="flex items-center justify-center gap-3 mb-4"
          >
            <Sparkles className="w-10 h-10 text-primary" />
            <h1 className="text-4xl md:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500">
              AutoForm AI
            </h1>
          </motion.div>
          <motion.p
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="text-muted-foreground text-lg"
          >
            Generate and schedule realistic mock responses to automatically populate Google Forms.
          </motion.p>
        </div>

        <div className="glass-card rounded-[2rem] p-8 md:p-12 relative overflow-hidden">
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-6"
              >
                <div>
                  <h2 className="text-2xl font-semibold mb-2">1. Connect Your Form</h2>
                  <p className="text-muted-foreground">Paste the link to your Google Form to extract the fields.</p>
                </div>

                <div className="space-y-4">
                  <div className="relative">
                    <Database className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground w-5 h-5" />
                    <input
                      type="url"
                      placeholder="https://docs.google.com/forms/..."
                      className="input-field w-full pl-12 pr-4 py-4 rounded-xl text-lg"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                  </div>
                  {scrapeError && <p className="text-red-400 text-sm mt-2">{scrapeError}</p>}
                  <button
                    onClick={handleScrape}
                    disabled={isScraping || !url}
                    className="btn-primary w-full py-4 rounded-xl font-semibold flex items-center justify-center gap-2"
                  >
                    {isScraping ? (
                      <span className="flex items-center gap-2">
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                          className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full"
                        />
                        Analyzing Form...
                      </span>
                    ) : (
                      <>
                        Extract Details <ArrowRight className="w-5 h-5" />
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}

            {step === 2 && formConfig && (
              <motion.div
                key="step-2"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-8"
              >
                <div>
                  <h2 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400 mb-2 truncate">
                    {formConfig.title}
                  </h2>
                  <p className="text-muted-foreground flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-400" />
                    {formConfig.fields.length} fields ({requiredCount} required) across {formConfig.pageCount} section
                    {formConfig.pageCount === 1 ? "" : "s"}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {typeSummary.map(([type, n]) => (
                      <span
                        key={type}
                        className="text-xs px-2.5 py-1 rounded-full bg-slate-800/70 border border-slate-700 text-slate-300"
                      >
                        {TYPE_LABELS[type] ?? type} × {n}
                      </span>
                    ))}
                  </div>
                </div>

                {formConfig.warnings?.length > 0 && (
                  <div className="p-4 bg-amber-500/10 border border-amber-500/20 text-amber-300 rounded-xl space-y-2">
                    {formConfig.warnings.map((w, i) => (
                      <p key={i} className="flex gap-2 text-sm">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{w}</span>
                      </p>
                    ))}
                  </div>
                )}

                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium mb-2 text-slate-300">Target Persona / Context</label>
                    <textarea
                      className="input-field w-full p-4 rounded-xl h-32 resize-none"
                      value={context}
                      onChange={(e) => setContext(e.target.value)}
                      placeholder="Describe the type of person filling out the form..."
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-2 text-slate-300">Response Count</label>
                      <input
                        type="number"
                        className="input-field w-full p-3 rounded-xl"
                        value={count}
                        onChange={(e) => setCount(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
                        min={1}
                        max={100}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2 text-slate-300">Spread Over (Hours)</label>
                      <input
                        type="number"
                        className="input-field w-full p-3 rounded-xl"
                        value={timeWindow}
                        onChange={(e) => setTimeWindow(Math.max(0, parseInt(e.target.value) || 0))}
                        min={0}
                      />
                    </div>
                  </div>
                </div>

                {testResult && (
                  <div
                    className={`p-4 rounded-xl border text-sm space-y-2 ${
                      testResult.ok
                        ? "bg-green-500/10 border-green-500/20 text-green-300"
                        : "bg-red-500/10 border-red-500/20 text-red-300"
                    }`}
                  >
                    <p className="font-medium">{testResult.message}</p>
                    {testResult.warnings.map((w, i) => (
                      <p key={i} className="opacity-80">
                        {w}
                      </p>
                    ))}
                  </div>
                )}

                {scheduleError && (
                  <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl">{scheduleError}</div>
                )}

                <div className="flex flex-wrap gap-4 pt-4">
                  <button
                    onClick={() => setStep(1)}
                    className="px-6 py-4 rounded-xl font-medium text-slate-300 hover:bg-slate-800 transition"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleTest}
                    disabled={isTesting || isScheduling}
                    className="px-6 py-4 rounded-xl font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 transition flex items-center gap-2 disabled:opacity-50"
                  >
                    <FlaskConical className="w-5 h-5" />
                    {isTesting ? "Submitting test..." : "Test 1 response"}
                  </button>
                  <button
                    onClick={handleSchedule}
                    disabled={isScheduling || isTesting || !formConfig.fields.length}
                    className="btn-primary flex-1 py-4 rounded-xl font-semibold flex items-center justify-center gap-2"
                  >
                    {isScheduling ? (
                      "Generating & Scheduling..."
                    ) : (
                      <>
                        <Send className="w-5 h-5" /> Launch Campaign
                      </>
                    )}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  &ldquo;Test 1 response&rdquo; submits a real response immediately and reports whether Google accepted it.
                </p>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step-3"
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="text-center py-12 space-y-6"
              >
                <div className="w-24 h-24 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
                  <CheckCircle className="w-12 h-12 text-green-400" />
                </div>
                <h2 className="text-3xl font-bold">Campaign Deployed!</h2>
                <p className="text-muted-foreground text-lg max-w-md mx-auto">
                  {count} responses have been generated and queued. They will be submitted randomly over the next{" "}
                  {timeWindow} hour{timeWindow === 1 ? "" : "s"}. You can safely close this page.
                </p>
                {scheduleWarnings.length > 0 && (
                  <div className="text-left max-w-md mx-auto p-4 bg-amber-500/10 border border-amber-500/20 text-amber-300 rounded-xl text-sm space-y-1">
                    {scheduleWarnings.map((w, i) => (
                      <p key={i}>{w}</p>
                    ))}
                  </div>
                )}
                {/* The scraped form is still valid, so another campaign against
                    the same form needs no re-extraction. The URL is kept either
                    way so nothing has to be pasted again. */}
                <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
                  <button
                    onClick={() => {
                      setStep(2);
                      setTestResult(null);
                      setScheduleWarnings([]);
                      setScheduleError("");
                    }}
                    className="px-8 py-3 btn-primary rounded-xl font-semibold"
                  >
                    New campaign, same form
                  </button>
                  <button
                    onClick={() => {
                      setStep(1);
                      setFormConfig(null);
                      setTestResult(null);
                      setScheduleWarnings([]);
                      setScheduleError("");
                    }}
                    className="px-8 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl transition"
                  >
                    Use a different form
                  </button>
                </div>
                {formConfig && (
                  <p className="text-xs text-muted-foreground truncate max-w-md mx-auto">
                    Form still loaded: {formConfig.title}
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </main>
  );
}
