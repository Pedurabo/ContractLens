"use client";

import { use, useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";

type Citation = {
  id?: string;
  documentId: string;
  documentName: string;
  quote: string;
  verified: boolean;
  startChar: number;
  endChar: number;
};

type DocumentCoverage = {
  documentId: string;
  documentName: string;
  fullDocumentCoverage: boolean;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  documentCoverage?: DocumentCoverage[];
};

type DocumentInfo = {
  id: string;
  name: string;
};

/**
 * A safe Markdown renderer for assistant answers.
 */
function MarkdownAnswer({ content }: { content: string }) {
  const normalizedContent = content.replace(/\\([\*\_#\(\)\[\]!\.\-\+])/g, "$1");

  return (
    <div className="markdown-answer">
      <ReactMarkdown
        components={{
          p: ({ children }) => (
            <p className="mb-3 text-sm leading-6 text-slate-700 last:mb-0">
              {children}
            </p>
          ),
          strong: ({ children }) => (
            <strong className="font-bold text-slate-900">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-slate-800">{children}</em>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 ml-4 list-disc space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 ml-4 list-decimal space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-sm leading-6 text-slate-700">{children}</li>
          ),
          h1: ({ children }) => (
            <h1 className="mt-4 mb-2 text-sm font-bold text-slate-900">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3 mb-1 text-xs font-bold text-slate-800">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2 mb-1 text-xs font-bold text-slate-800">
              {children}
            </h3>
          ),
          a: ({ href, children }) => (
            <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

function MultiDocChatContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const docIdsParam = searchParams.get("documents");

  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isAsking, setIsAsking] = useState(false);
  const [chatError, setChatError] = useState("");

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const accumulatedContentRef = useRef<string>("");

  const selectedIds = docIdsParam ? docIdsParam.split(",") : [];

  useEffect(() => {
    if (selectedIds.length < 2) {
      setError("Please select at least 2 documents to compare.");
      setLoading(false);
      return;
    }

    async function fetchDocInfo() {
      try {
        const docInfo: DocumentInfo[] = [];
        for (const id of selectedIds) {
          const res = await fetch(`/api/documents/${id}`);
          if (res.ok) {
            const data = await res.json();
            docInfo.push({ id: data.id, name: data.name });
          }
        }
        setDocuments(docInfo);
      } catch (err) {
        console.error("Failed to load document info:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchDocInfo();
  }, [docIdsParam]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isAsking]);

  async function askQuestion() {
    const finalQuestion = question.trim();
    if (!finalQuestion || isAsking || selectedIds.length < 2) return;

    setIsAsking(true);
    setChatError("");
    setQuestion("");
    accumulatedContentRef.current = "";

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: finalQuestion,
    };
    setMessages(prev => [...prev, userMessage]);

    const tempAssistantMsgId = crypto.randomUUID();

    try {
      const response = await fetch("/api/chat/multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentIds: selectedIds,
          question: finalQuestion,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to get an answer.");
      }

      if (!response.body) throw new Error("No response body.");

      setMessages(prev => [...prev, {
        id: tempAssistantMsgId,
        role: "assistant",
        content: "",
      }]);

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
            if (event.type === "content") {
              accumulatedContentRef.current += event.text || "";
              setMessages(prev => prev.map(m =>
                m.id === tempAssistantMsgId ? { ...m, content: accumulatedContentRef.current } : m
              ));
            } else if (event.type === "status") {
              setMessages(prev => prev.map(m =>
                m.id === tempAssistantMsgId ? { ...m, documentCoverage: event.documentCoverage } : m
              ));
            } else if (event.type === "final") {
              setMessages(prev => prev.map(m =>
                m.id === tempAssistantMsgId ? {
                  ...m,
                  id: event.messageId || m.id,
                  citations: event.citations,
                  documentCoverage: event.documentCoverage || m.documentCoverage
                } : m
              ));
            }
          } catch (e) {
            console.error("Stream parse error:", e);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "An error occurred.";
      setChatError(msg);
      setMessages(prev => prev.map(m =>
        m.id === tempAssistantMsgId ? { ...m, content: m.content || "I couldn't complete that request." } : m
      ));
    } finally {
      setIsAsking(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-xl font-semibold text-slate-900">Loading documents...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded-2xl border border-red-200 bg-white p-8 shadow-sm text-center">
          <h1 className="text-xl font-semibold text-slate-900">Selection Error</h1>
          <p className="mt-3 text-sm text-red-600">{error}</p>
          <button onClick={() => router.push("/")} className="mt-6 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">
            Back to library
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-slate-100 overflow-hidden">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center gap-4">
          <button onClick={() => router.push("/")} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            ← Library
          </button>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Ask across documents</h1>
            <p className="text-xs text-slate-500">
              Comparing: {documents.map(d => d.name).join(", ")}
            </p>
          </div>
        </div>
      </header>

      {/* Workspace */}
      <div className="flex-1 flex flex-col min-h-0 items-center p-6 overflow-y-auto">
        <div className="w-full max-w-4xl space-y-6">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-3xl font-bold shadow-sm">✦</div>
              <h3 className="mt-6 text-xl font-bold text-slate-900">What would you like to compare?</h3>
              <p className="mt-2 max-w-md text-slate-500 text-sm leading-6">
                Ask a question that involves {documents.length} contracts. ContractLens will retrieve relevant sections from each and provide a verified answer.
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                <div className={m.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-4 py-3 text-sm leading-6 text-white"
                  : "w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                }>
                  {m.role === "assistant" && (
                    <div className="mb-4 flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">ContractLens Analysis</span>
                      {m.citations && m.citations.length > 0 && (
                        <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold text-emerald-700 uppercase">
                          ✓ {m.citations.length} Verified Citations
                        </span>
                      )}
                    </div>
                  )}

                  <MarkdownAnswer content={m.content} />

                  {m.role === "assistant" && m.documentCoverage && (
                    <div className="mt-6 pt-6 border-t border-slate-100">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Search Coverage</p>
                      <div className="flex flex-wrap gap-2">
                        {m.documentCoverage.map((cov, i) => (
                          <div key={i} className="flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-[11px] border border-slate-200 text-slate-600">
                            <span className={cov.fullDocumentCoverage ? "text-emerald-500" : "text-amber-500"}>●</span>
                            <span className="font-medium truncate max-w-[150px]">{cov.documentName}</span>
                            <span className="text-slate-400">({cov.fullDocumentCoverage ? "Full" : "Sections"})</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {m.role === "assistant" && m.citations && m.citations.length > 0 && (
                    <div className="mt-6 space-y-3">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Verified Citations</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {m.citations.map((c, i) => (
                          <div key={i} className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <span className="text-[10px] font-bold text-emerald-700 uppercase">{c.documentName}</span>
                              <a
                                href={`/documents/${c.documentId}?start=${c.startChar}&end=${c.endChar}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[10px] font-bold text-blue-600 hover:text-blue-800 flex-shrink-0"
                              >
                                Open →
                              </a>
                            </div>
                            <blockquote className="text-xs leading-5 text-slate-700 italic font-medium">
                              "{c.quote}"
                            </blockquote>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
          {chatError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {chatError}
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-slate-200 bg-white p-6">
        <div className="mx-auto max-w-4xl">
          <div className="relative flex items-end gap-3 rounded-2xl border border-slate-300 bg-white p-2 shadow-sm focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-50">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  askQuestion();
                }
              }}
              placeholder="Ask a question across these documents..."
              rows={2}
              className="flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm text-slate-900 focus:ring-0 placeholder:text-slate-400"
              disabled={isAsking}
            />
            <button
              onClick={askQuestion}
              disabled={isAsking || !question.trim()}
              className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:bg-slate-200 disabled:cursor-not-allowed"
            >
              {isAsking ? "Asking..." : "Ask AI"}
            </button>
          </div>
          <p className="mt-3 text-center text-[10px] text-slate-400">
            ContractLens answers are verified against literal contract text from multiple sources.
          </p>
        </div>
      </div>
    </main>
  );
}

export default function MultiDocChatPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-xl font-semibold text-slate-900">Loading...</div>
      </div>
    }>
      <MultiDocChatContent />
    </Suspense>
  );
}
