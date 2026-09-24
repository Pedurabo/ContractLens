"use client";

import { useEffect, useState, useRef } from "react";

interface DocumentItem {
  id: string;
  name: string;
  status: string;
}

interface Citation {
  quote: string;
  verified: boolean;
  startChar: number;
  endChar: number;
}

interface ActivityRound {
  round: number;
  tool: string;
  message: string;
}

export default function ResearchPage() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [selectedDocId, setSelectedDocId] = useState("");
  const [question, setQuestion] = useState("");
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [loadingResearch, setLoadingResearch] = useState(false);
  const [error, setError] = useState("");

  const [statusMessage, setStatusMessage] = useState("");
  const [activities, setActivities] = useState<ActivityRound[]>([]);
  const [finalAnswer, setFinalAnswer] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [roundsUsed, setRoundsUsed] = useState(0);
  const [toolsUsed, setToolsUsed] = useState<string[]>([]);

  useEffect(() => {
    async function fetchDocs() {
      try {
        setLoadingDocs(true);
        const res = await fetch("/api/documents");
        if (!res.ok) throw new Error("Failed to load documents.");
        const data = await res.json();

        const rawDocs: DocumentItem[] = Array.isArray(data)
          ? data
          : Array.isArray(data.value)
            ? data.value
            : [];

        setDocuments(rawDocs.filter(d => d.status === "PROCESSED"));
      } catch (err: any) {
        setError(err.message || "Could not load documents.");
      } finally {
        setLoadingDocs(false);
      }
    }
    fetchDocs();
  }, []);

  async function startResearch() {
    if (!selectedDocId || !question.trim()) {
      setError("Please select a contract and provide a research question.");
      return;
    }

    try {
      setLoadingResearch(true);
      setError("");
      setStatusMessage("Connecting to research agent...");
      setActivities([]);
      setFinalAnswer("");
      setCitations([]);
      setRoundsUsed(0);
      setToolsUsed([]);

      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: selectedDocId, question }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "Research agent request failed.");
      }

      if (!response.body) {
        throw new Error("No readable stream response received.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "status") {
              setStatusMessage(event.message || "");
            } else if (event.type === "activity") {
              setActivities(prev => [...prev, {
                round: event.round,
                tool: event.tool,
                message: event.message
              }]);
            } else if (event.type === "final") {
              setFinalAnswer(event.answer || "");
              setCitations(event.citations || []);
              setRoundsUsed(event.roundsCompleted || event.roundsUsed || 0);
              setToolsUsed(
                event.toolsUsed ||
                  Array.from(new Set(activities.map((item) => item.tool)))
              );
              setStatusMessage("Research complete.");
            } else if (event.type === "error") {
              setError(event.error || "Research agent request failed.");
              setStatusMessage("Research failed.");
            }
          } catch (jsonErr) {
            console.error("Failed to parse event turn line:", jsonErr);
          }
        }
      }

    } catch (err: any) {
      setError(err.message || "An unexpected error occurred during research loop.");
    } finally {
      setLoadingResearch(false);
    }
  }

  function openCitationLink(cite: Citation) {
    const params = new URLSearchParams({
      start: String(cite.startChar),
      end: String(cite.endChar),
    });
    window.open(`/documents/${selectedDocId}?${params.toString()}`, "_blank");
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 pb-16">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <a href="/" className="mb-2 inline-flex text-sm font-medium text-slate-500 hover:text-slate-900">
              ← Library Dashboard
            </a>
            <h1 className="text-3xl font-bold tracking-tight">Agentic Document Research</h1>
            <p className="mt-2 text-sm text-slate-600">
              Deploy an autonomous multi-round Gemini agent with specific contract exploration tools.
            </p>
          </div>
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700 border border-blue-200">
            Multi-Round Loop Agent
          </span>
        </div>

        {/* Configuration Panel */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="space-y-4">
            <div>
              <label htmlFor="select-contract" className="block text-sm font-semibold text-slate-700 mb-2">
                Select Contract to Research
              </label>
              <select
                id="select-contract"
                value={selectedDocId}
                disabled={loadingDocs || loadingResearch}
                onChange={(e) => {
                  setSelectedDocId(e.target.value);
                  setError("");
                }}
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
              >
                <option value="">-- Choose a fully processed contract --</option>
                {documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="research-question" className="block text-sm font-semibold text-slate-700 mb-2">
                Deep Research Question
              </label>
              <textarea
                id="research-question"
                rows={3}
                value={question}
                disabled={loadingResearch}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask a complex query requiring multi-stage research (e.g., cross-referencing liability provisions or identifying hidden penalties)..."
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 resize-none"
              />
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 pt-4">
              <span className="text-xs text-slate-400">
                Agent budget: Max 6 consecutive rounds with list_clauses, search_document, and get_section.
              </span>
              <button
                onClick={startResearch}
                disabled={loadingResearch || !selectedDocId || !question.trim()}
                className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
              >
                {loadingResearch ? "Agent Running..." : "Execute Agent Research"}
              </button>
            </div>
          </div>
        </section>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Live Tracking / Output Area */}
        {(loadingResearch || finalAnswer || activities.length > 0) && (
          <section className="mt-6 space-y-6">

            {/* Status / Activity log */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">
                Agent Execution Status & Trace
              </h3>

              <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700 mb-4">
                <div className={`h-2 w-2 rounded-full bg-blue-600 ${loadingResearch ? "animate-ping" : ""}`} />
                <span>{statusMessage}</span>
              </div>

              {activities.length > 0 && (
                <div className="space-y-3 border-t border-slate-100 pt-4">
                  {activities.map((act, i) => (
                    <div key={i} className="flex items-start gap-3 text-sm leading-6">
                      <span className="inline-flex h-6 w-16 items-center justify-center rounded bg-slate-100 text-[11px] font-bold text-slate-500 shrink-0">
                        Round {act.round}
                      </span>
                      <span className="font-semibold text-slate-800 shrink-0">
                        [{act.tool}]
                      </span>
                      <p className="text-slate-600">{act.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Final Substantive Result */}
            {finalAnswer && (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">Research Conclusion</h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Delivered in {roundsUsed} rounds using: {toolsUsed.join(", ") || "None"}
                  </p>
                </div>

                <div className="prose max-w-none text-sm leading-7 text-slate-700 whitespace-pre-wrap bg-slate-50 rounded-xl p-4 border border-slate-100">
                  {finalAnswer}
                </div>

                {/* Citations section */}
                {citations.length > 0 && (
                  <div className="border-t border-slate-100 pt-4 space-y-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Verified Citation Evidence
                    </h4>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {citations.map((cite, i) => (
                        <div key={i} className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 flex flex-col justify-between">
                          <blockquote className="text-xs leading-5 text-slate-700 italic mb-3">
                            “{cite.quote}”
                          </blockquote>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-bold">
                              ✓ VERIFIED
                            </span>
                            <button
                              onClick={() => openCitationLink(cite)}
                              className="text-xs font-semibold text-blue-600 hover:underline inline-flex items-center"
                            >
                              Open in document →
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

          </section>
        )}

      </div>
    </main>
  );
}
