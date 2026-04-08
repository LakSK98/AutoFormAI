"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Key, Sparkles, Send, CheckCircle, Database } from "lucide-react";
import axios from "axios";

export default function Home() {
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState("");

  const [formConfig, setFormConfig] = useState<any>(null);

  const [context, setContext] = useState("A software developer using the product for a month.");
  const [count, setCount] = useState(5);
  const [timeWindow, setTimeWindow] = useState(2);

  const [isScheduling, setIsScheduling] = useState(false);
  const [scheduleSuccess, setScheduleSuccess] = useState(false);
  const [scheduleError, setScheduleError] = useState("");

  const handleScrape = async () => {
    if (!url) return;
    setIsScraping(true);
    setScrapeError("");
    try {
      const res = await axios.post("/api/scrape", { url });
      setFormConfig(res.data);
      setStep(2);
    } catch (err: any) {
      setScrapeError(err.response?.data?.error || "Failed to scrape the form.");
    } finally {
      setIsScraping(false);
    }
  };

  const handleSchedule = async () => {
    if (!context) {
      setScheduleError("Please fill in all required fields.");
      return;
    }

    setIsScheduling(true);
    setScheduleError("");
    try {
      await axios.post("/api/generate-and-schedule", {
        formUrl: formConfig.submitUrl,
        fields: formConfig.fields,
        fbzx: formConfig.fbzx,
        context,
        count,
        timeWindowHours: timeWindow,
      });
      setScheduleSuccess(true);
      setStep(3);
    } catch (err: any) {
      const msg = err.response?.data?.error || "Failed to schedule.";
      setScheduleError(msg);
    } finally {
      setIsScheduling(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Dynamic Background Elements */}
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
                  {scrapeError && (
                    <p className="text-red-400 text-sm mt-2">{scrapeError}</p>
                  )}
                  <button
                    onClick={handleScrape}
                    disabled={isScraping || !url}
                    className="btn-primary w-full py-4 rounded-xl font-semibold flex items-center justify-center gap-2"
                  >
                    {isScraping ? (
                      <span className="flex items-center gap-2">
                        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }} className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full" />
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
                    <CheckCircle className="w-4 h-4 text-green-400" /> Discovered {formConfig.fields?.length} fields
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-1 gap-8">
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
                          onChange={(e) => setCount(parseInt(e.target.value) || 1)}
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
                          onChange={(e) => setTimeWindow(parseInt(e.target.value) || 0)}
                          min={0}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {scheduleError && (
                  <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl">
                    {scheduleError}
                  </div>
                )}

                <div className="flex gap-4 pt-4">
                  <button
                    onClick={() => setStep(1)}
                    className="px-6 py-4 rounded-xl font-medium text-slate-300 hover:bg-slate-800 transition"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleSchedule}
                    disabled={isScheduling || !formConfig?.fields?.length}
                    className="btn-primary flex-1 py-4 rounded-xl font-semibold flex items-center justify-center gap-2"
                  >
                    {isScheduling ? "Generating & Scheduling..." : <><Send className="w-5 h-5" /> Launch Campaign</>}
                  </button>
                </div>
              </motion.div>
            )}

            {step === 3 && scheduleSuccess && (
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
                  {count} responses have been successfully generated and queued. They will be submitted randomly over the next {timeWindow} hours. You can safely close this page.
                </p>
                <button
                  onClick={() => {
                    setStep(1);
                    setUrl("");
                  }}
                  className="mt-8 px-8 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl transition"
                >
                  Start Another
                </button>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </main>
  );
}
