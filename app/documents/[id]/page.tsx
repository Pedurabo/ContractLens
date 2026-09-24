"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";

type Citation = {
  id?: string;
  quote: string;
  verified: boolean;
  startChar: number;
  endChar: number;
  pageNumber?: number | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  verified?: boolean;
  stopped?: boolean;
  fullDocumentCoverage?: boolean;
};

type DocumentChunk = {
  id: string;
  chunkIndex: number;
  content: string;
  startChar: number;
  endChar: number;
  pageNumber?: number | null;
};

type DocumentData = {
  id: string;
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
  status: string;
  extractedText: string;
  createdAt: string;
  chunks: DocumentChunk[];
};

/**
 * A safe Markdown renderer for assistant answers.
 * It handles common formatting and unescapes Gemini-provided Markdown sequences.
 */
function MarkdownAnswer({ content }: { content: string }) {
  // Pre-process: unescape common Gemini escapes (\*, \_, \#, \!, \., \-, \+)
  // This ensures that sequences like \*\*bold\*\* or 1\. render correctly as Markdown.
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
          // Ensure links are safe if any appear
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

export default function DocumentWorkspace({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [document, setDocument] = useState<DocumentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [chatId, setChatId] = useState<string | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isAsking, setIsAsking] = useState(false);
  const [chatError, setChatError] = useState("");

  const [highlightStart, setHighlightStart] = useState<number | null>(null);
  const [highlightEnd, setHighlightEnd] = useState<number | null>(null);

  const highlightRef = useRef<HTMLElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const accumulatedContentRef = useRef<string>("");
  const isAskingRef = useRef<boolean>(false);

  useEffect(() => {
    async function loadWorkspace() {
      try {
        setLoading(true);
        setError("");

        // Fetch document details
        const response = await fetch(`/api/documents/${id}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to load document.");
        }
        setDocument(data);

        // Fetch saved chat history
        const chatsResponse = await fetch(`/api/documents/${id}/chats`);
        const chatsData = await chatsResponse.json();

        if (chatsResponse.ok && chatsData.chatId) {
          setChatId(chatsData.chatId);
          if (Array.isArray(chatsData.messages)) {
            const mappedMessages: ChatMessage[] = chatsData.messages.map((m: any) => {
              const hasVerifiedCitations = Array.isArray(m.citations) && m.citations.some((c: any) => c.verified);
              return {
                id: m.id,
                role: m.role,
                content: m.content,
                citations: m.citations || [],
                verified: hasVerifiedCitations,
                stopped: m.stopped || false,
                fullDocumentCoverage: true,
              };
            });
            setMessages(mappedMessages);
          }
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "An unexpected error occurred.");
      } finally {
        setLoading(false);
      }
    }

    loadWorkspace();
  }, [id]);

  // Handle cross-document citation navigation via URL query parameters
  useEffect(() => {
    if (!document) return;

    const startStr = searchParams.get("start");
    const endStr = searchParams.get("end");

    if (startStr !== null && endStr !== null) {
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (
        !isNaN(start) &&
        !isNaN(end) &&
        start >= 0 &&
        end > start &&
        end <= document.extractedText.length
      ) {
        setHighlightStart(start);
        setHighlightEnd(end);
      }
    }
  }, [document, searchParams]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
    });
  }, [messages, isAsking]);

  useEffect(() => {
    if (highlightStart !== null && highlightEnd !== null) {
      setTimeout(() => {
        highlightRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 50);
    }
  }, [highlightStart, highlightEnd]);

  async function askQuestion(questionOverride?: string) {
    const finalQuestion = (questionOverride ?? question).trim();

    if (!finalQuestion || !document || isAsking || isAskingRef.current) {
      return;
    }

    isAskingRef.current = true;
    setIsAsking(true);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: finalQuestion,
    };

    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setChatError("");
    accumulatedContentRef.current = "";

    const tempAssistantMsgId = crypto.randomUUID();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          documentId: document.id,
          question: finalQuestion,
          chatId: chatId || undefined,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to answer the question.");
      }

      if (!response.body) {
        throw new Error("No response body received from chat stream.");
      }

      // Add the initial temporary assistant message placeholder
      setMessages((current) => [
        ...current,
        {
          id: tempAssistantMsgId,
          role: "assistant",
          content: "",
          citations: [],
          verified: false,
          stopped: false,
          fullDocumentCoverage: true,
        },
      ]);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentCoverage = true;
      let serverMessageId: string | null = null;

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
              if (event.chatId) {
                setChatId(event.chatId);
              }
              if (event.messageId) {
                serverMessageId = event.messageId;
                setActiveMessageId(event.messageId);
              }
              if (event.fullDocumentCoverage !== undefined) {
                currentCoverage = event.fullDocumentCoverage;
                setMessages((current) =>
                  current.map((m) =>
                    m.id === tempAssistantMsgId
                      ? { ...m, fullDocumentCoverage: event.fullDocumentCoverage }
                      : m
                  )
                );
              }
            } else if (event.type === "content") {
              const delta = event.text || "";
              accumulatedContentRef.current += delta;
              setMessages((current) =>
                current.map((m) =>
                  m.id === tempAssistantMsgId
                    ? { ...m, content: accumulatedContentRef.current }
                    : m
                )
              );
            } else if (event.type === "final") {
              if (event.message) {
                const serverMsg = event.message;
                const hasVerifiedCitations = Array.isArray(serverMsg.citations) && serverMsg.citations.some((c: any) => c.verified);
                setMessages((current) =>
                  current.map((m) =>
                    m.id === tempAssistantMsgId
                      ? {
                          ...m,
                          id: serverMsg.id || m.id,
                          content: serverMsg.content,
                          citations: serverMsg.citations || [],
                          verified: hasVerifiedCitations,
                          stopped: serverMsg.stopped ?? false,
                          fullDocumentCoverage: event.fullDocumentCoverage ?? currentCoverage,
                        }
                      : m
                  )
                );
                setActiveMessageId(null);
              }
            }
          } catch (jsonErr) {
            console.error("Failed to parse stream event line:", jsonErr);
          }
        }
      }
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        const message = err instanceof Error ? err.message : "An unexpected error occurred.";
        setChatError(message);
        setMessages((current) =>
          current.map((m) =>
            m.id === tempAssistantMsgId
              ? {
                  ...m,
                  content: m.content || "I couldn't complete that request. Please try again.",
                  stopped: true,
                }
              : m
          )
        );
      }
      // If it's an abort, stopGeneration already handled state and persistence
    } finally {
      setIsAsking(false);
      isAskingRef.current = false;
      abortControllerRef.current = null;
      setActiveMessageId(null);
    }
  }

  async function stopGeneration() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    if (activeMessageId) {
      const finalContent = accumulatedContentRef.current;

      // Update UI immediately
      setMessages((current) =>
        current.map((m) =>
          m.id === activeMessageId || (m.role === "assistant" && !m.id.includes("-") && current.indexOf(m) === current.length - 1)
            ? { ...m, stopped: true, content: finalContent }
            : m
        )
      );

      // Persist the stop state and partial content to the backend explicitly
      try {
        await fetch("/api/chat/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageId: activeMessageId,
            content: finalContent,
          }),
        });
      } catch (e) {
        console.error("Failed to notify backend about stop:", e);
      }
    }

    setIsAsking(false);
    isAskingRef.current = false;
    setActiveMessageId(null);
  }

  function openCitation(citation: Citation) {
    setHighlightStart(citation.startChar);
    setHighlightEnd(citation.endChar);
  }

  function handleQuestionKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askQuestion();
    }
  }

  function renderDocumentText() {
    if (!document) {
      return null;
    }

    if (
      highlightStart === null ||
      highlightEnd === null ||
      highlightStart < 0 ||
      highlightEnd <= highlightStart ||
      highlightEnd > document.extractedText.length
    ) {
      return document.extractedText;
    }

    const before = document.extractedText.slice(0, highlightStart);
    const highlighted = document.extractedText.slice(highlightStart, highlightEnd);
    const after = document.extractedText.slice(highlightEnd);

    return (
      <>
        {before}
        <mark ref={highlightRef} className="rounded bg-yellow-200 px-0.5 text-slate-900">
          {highlighted}
        </mark>
        {after}
      </>
    );
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="text-xl font-semibold text-slate-900">Loading contract...</div>
          <p className="mt-2 text-sm text-slate-500">Preparing the document workspace.</p>
        </div>
      </main>
    );
  }

  if (error || !document) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded-2xl border border-red-200 bg-white p-8 shadow-sm text-center">
          <h1 className="text-xl font-semibold text-slate-900">Could not open contract</h1>
          <p className="mt-3 text-sm text-red-600">{error || "Document not found."}</p>
          <button
            onClick={() => router.push("/")}
            className="mt-6 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Back to library
          </button>
        </div>
      </main>
    );
  }

  const sizeMb = (document.size / 1024 / 1024).toFixed(2);
  const hasMessages = messages.length > 0;

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-slate-100">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex min-w-0 items-center gap-4">
          <button
            onClick={() => router.push("/")}
            className="flex-shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Library
          </button>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="max-w-xl truncate text-lg font-semibold text-slate-900">{document.name}</h1>
              <span className="flex-shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                {document.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {sizeMb} MB • {document.chunks.length} searchable chunks
            </p>
          </div>
        </div>

        <div className="flex-shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">
          ✓ Verified citations
        </div>
      </header>

      {/* Workspace */}
      <div className="flex min-h-0 flex-1">
        {/* Document */}
        <section className="flex min-w-0 flex-1 flex-col border-r border-slate-200">
          <div className="flex-shrink-0 border-b border-slate-200 bg-white px-6 py-3">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Contract</h2>
                <p className="mt-1 text-xs text-slate-500">Extracted document text</p>
              </div>

              {highlightStart !== null && (
                <button
                  onClick={() => {
                    setHighlightStart(null);
                    setHighlightEnd(null);
                  }}
                  className="text-xs font-medium text-slate-500 hover:text-slate-900"
                >
                  Clear highlight
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            <article className="mx-auto max-w-4xl rounded-xl border border-slate-200 bg-white px-10 py-10 shadow-sm">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-7 text-slate-700">
                {renderDocumentText()}
              </pre>
            </article>
          </div>
        </section>

        {/* Chat */}
        <aside className="flex w-[440px] flex-shrink-0 flex-col bg-white">
          <div className="flex-shrink-0 border-b border-slate-200 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900">Ask ContractLens</h2>
            <p className="mt-1 text-xs text-slate-500">Answers are grounded in this contract.</p>
          </div>

          {/* Empty chat */}
          {!hasMessages ? (
            <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-xl font-bold">✦</div>
              <h3 className="mt-4 font-semibold text-slate-900">Ask about this contract</h3>
              <p className="mt-2 max-w-xs text-sm leading-6 text-slate-500">
                ContractLens answers using retrieved document passages and independently verifies supporting quotations.
              </p>

              <div className="mt-6 flex flex-col gap-2">
                <button
                  onClick={() => askQuestion("What are the most important requirements in this document?")}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                >
                  What are the most important requirements?
                </button>
                <button
                  onClick={() => askQuestion("What does this document say about verified quotes?")}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                >
                  What does it say about verified quotes?
                </button>
                <button
                  onClick={() => askQuestion("What are the submission requirements?")}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                >
                  What are the submission requirements?
                </button>
              </div>
            </div>
          ) : (
            /* Messages */
            <div className="flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                {messages.map((message) => (
                  <div key={message.id}>
                    {message.role === "user" ? (
                      <div className="flex justify-end">
                        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-4 py-3 text-sm leading-6 text-white">
                          {message.content}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="mb-3 flex items-center justify-between">
                          <span className="text-xs font-semibold text-slate-700">ContractLens</span>
                          {message.stopped ? (
                            message.citations && message.citations.length > 0 && message.verified ? (
                              <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">
                                ✓ VERIFIED
                              </span>
                            ) : (
                              <span className="rounded-full bg-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600">
                                Stopped before citation verification
                              </span>
                            )
                          ) : message.verified && message.citations && message.citations.length > 0 ? (
                            <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">
                              ✓ VERIFIED
                            </span>
                          ) : (
                            <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-700">
                              NO VERIFIED QUOTE
                            </span>
                          )}
                        </div>

                        <MarkdownAnswer content={message.content} />

                        {message.stopped && (
                          <div className="mt-2 text-[11px] font-medium text-slate-500 italic">
                            Generation stopped by user or interrupted.
                          </div>
                        )}

                        {message.fullDocumentCoverage === false && (
                          <div className="mt-2 rounded bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 inline-block">
                            ℹ Answer based on retrieved passages from this document.
                          </div>
                        )}

                        {message.citations && message.citations.length > 0 && (
                          <div className="mt-4 space-y-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                              Verified quotations
                            </p>

                            {message.citations.map((citation, index) => (
                              <button
                                key={`${citation.startChar}-${citation.endChar}-${index}`}
                                onClick={() => openCitation(citation)}
                                className="block w-full rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-left transition hover:border-emerald-400 hover:bg-emerald-100"
                              >
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                                    ✓ Verified quote
                                  </span>
                                  <span className="text-[10px] text-emerald-700">Open in document →</span>
                                </div>
                                <blockquote className="text-xs leading-5 text-slate-700">
                                  “{citation.quote}”
                                </blockquote>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                <div ref={messagesEndRef} />
              </div>
            </div>
          )}

          {/* Error */}
          {chatError && (
            <div className="mx-4 mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {chatError}
            </div>
          )}

          {/* Input */}
          <div className="flex-shrink-0 border-t border-slate-200 p-4">
            <div className="flex items-end gap-2 rounded-xl border border-slate-300 bg-white p-2 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={handleQuestionKeyDown}
                disabled={isAsking}
                rows={2}
                placeholder="Ask a question about this contract..."
                className="max-h-32 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
              />

              {isAsking ? (
                <button
                  onClick={stopGeneration}
                  className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-700"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => askQuestion()}
                  disabled={question.trim().length === 0}
                  className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  Ask
                </button>
              )}
            </div>

            <p className="mt-2 text-center text-[11px] text-slate-400">
              Enter to send • Shift+Enter for a new line
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
