"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Document {
  id: string;
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
  status: string;
  errorMessage?: string | null;
  createdAt: string;
}

export default function Home() {
  const router = useRouter();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  const [processStep, setProcessStep] = useState<
    "idle" | "uploading" | "extracting" | "success"
  >("idle");

  const [documents, setDocuments] = useState<Document[]>([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState(true);

  // Part B: Multi-document selection
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchDocuments();
  }, []);

  async function fetchDocuments() {
    setIsLoadingDocs(true);

    try {
      const response = await fetch("/api/documents");

      if (!response.ok) {
        throw new Error("Failed to load documents.");
      }

      const data = await response.json();
      setDocuments(data);
    } catch (err) {
      console.error("Failed to fetch documents:", err);
    } finally {
      setIsLoadingDocs(false);
    }
  }

  function validateFile(selectedFile: File) {
    setError("");
    setProcessStep("idle");

    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (!allowedTypes.includes(selectedFile.type)) {
      setFile(null);
      setError(
        "Unsupported file type. Please upload a PDF or DOCX contract."
      );
      return;
    }

    setFile(selectedFile);
  }

  function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const selectedFile = event.target.files?.[0];

    if (selectedFile) {
      validateFile(selectedFile);
    }
  }

  function handleDrop(
    event: React.DragEvent<HTMLDivElement>
  ) {
    event.preventDefault();

    const droppedFile = event.dataTransfer.files?.[0];

    if (droppedFile) {
      validateFile(droppedFile);
    }
  }

  async function handleAnalyze() {
    if (!file) return;

    setIsProcessing(true);
    setError("");
    setProcessStep("uploading");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });

      setProcessStep("extracting");

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Failed to process document."
        );
      }

      // If the backend returned a FAILED status with 200, we should show it
      if (data.status === "FAILED") {
        setError(data.error || "Processing failed.");
        setProcessStep("idle");
      } else {
        setProcessStep("success");
        setFile(null);

        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }

        setTimeout(() => {
          setProcessStep("idle");
        }, 3000);
      }

      await fetchDocuments();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "An error occurred during analysis."
      );

      setProcessStep("idle");
      await fetchDocuments(); // Refresh to show the FAILED record if it was created
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleDelete(id: string) {
    const confirmed = confirm(
      "Are you sure you want to delete this document? All related chunks and analysis will be removed."
    );

    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(
        `/api/documents/${id}`,
        {
          method: "DELETE",
        }
      );

      if (response.ok) {
        setDocuments((currentDocuments) =>
          currentDocuments.filter(
            (document) => document.id !== id
          )
        );
        // Remove from selection if deleted
        setSelectedDocIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } else {
        const data = await response.json();

        alert(
          data.error || "Failed to delete document."
        );
      }
    } catch (err) {
      console.error("Delete error:", err);

      alert(
        "An error occurred while deleting the document."
      );
    }
  }

  function openDocument(doc: Document) {
    if (doc.status === "PROCESSED") {
      router.push(`/documents/${doc.id}`);
    }
  }

  function toggleDocumentSelection(id: string) {
    setSelectedDocIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function startMultiDocChat() {
    if (selectedDocIds.size < 2) return;
    const ids = Array.from(selectedDocIds).join(",");
    router.push(`/chat/multi?documents=${ids}`);
  }

  return (
    <main className="min-h-screen bg-slate-50 pb-20 text-slate-900">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              ContractLens
            </h1>

            <p className="text-sm text-slate-500">
              AI contract analysis with verified citations
            </p>
          </div>

          <div className="flex items-center gap-4">
            {selectedDocIds.size >= 2 && (
              <button
                onClick={startMultiDocChat}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition"
              >
                Ask across {selectedDocIds.size} documents
              </button>
            )}
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              Verified answers
            </span>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-12">
        {/* Hero */}
        <div className="mx-auto max-w-3xl text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-blue-600">
            Contract intelligence
          </p>

          <h2 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Understand your contracts faster.
          </h2>

          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-slate-600">
            Upload a contract, ask questions, and receive
            answers backed by quotations verified against the
            original document.
          </p>
        </div>

        {/* Upload */}
        <div className="mx-auto mt-12 max-w-3xl">
          <div
            onDragOver={(event) =>
              event.preventDefault()
            }
            onDrop={handleDrop}
            onClick={() => {
              if (!isProcessing) {
                fileInputRef.current?.click();
              }
            }}
            className={`rounded-2xl border-2 border-dashed px-8 py-14 text-center shadow-sm transition ${
              isProcessing
                ? "cursor-not-allowed border-slate-200 bg-slate-100"
                : "cursor-pointer border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50/30"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx"
              onChange={handleFileChange}
              className="hidden"
              disabled={isProcessing}
            />

            <div
              className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-2xl ${
                isProcessing
                  ? "bg-slate-200 text-slate-400"
                  : "bg-blue-50 text-blue-600"
              }`}
            >
              {isProcessing ? "..." : "↑"}
            </div>

            <h3 className="text-lg font-semibold">
              {isProcessing
                ? "Processing..."
                : "Drop your contract here"}
            </h3>

            <p className="mt-2 text-sm text-slate-500">
              {isProcessing
                ? "Please wait while we handle your document"
                : "or click to select a document"}
            </p>

            <p className="mt-5 text-xs font-medium text-slate-400">
              PDF and DOCX
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Success */}
          {processStep === "success" && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              Document processed successfully!
            </div>
          )}

          {/* Selected file */}
          {file && !isProcessing && (
            <div className="mt-4 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4">
              <div>
                <p className="font-medium text-emerald-900">
                  {file.name}
                </p>

                <p className="mt-1 text-sm text-emerald-700">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                  {" • "}
                  Ready to process
                </p>
              </div>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();

                  setFile(null);
                  setProcessStep("idle");

                  if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                  }
                }}
                className="text-sm font-medium text-emerald-800 hover:text-emerald-950"
              >
                Remove
              </button>
            </div>
          )}

          {/* Analyse button */}
          {file && (
            <button
              type="button"
              disabled={isProcessing}
              onClick={handleAnalyze}
              className={`mt-5 w-full rounded-xl px-5 py-4 font-semibold text-white transition ${
                isProcessing
                  ? "cursor-not-allowed bg-slate-400"
                  : "bg-slate-900 hover:bg-slate-700"
              }`}
            >
              {processStep === "uploading"
                ? "Uploading..."
                : processStep === "extracting"
                  ? "Extracting text..."
                  : "Analyse contract"}
            </button>
          )}
        </div>

        {/* Document Library */}
        <div className="mx-auto mt-20 max-w-3xl">
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-xl font-bold">
              Document Library
            </h3>

            <span className="text-sm text-slate-500">
              {documents.length}{" "}
              {documents.length === 1
                ? "document"
                : "documents"}
              {selectedDocIds.size > 0 && ` (${selectedDocIds.size} selected)`}
            </span>
          </div>

          {isLoadingDocs ? (
            <div className="py-10 text-center text-slate-400">
              Loading your documents...
            </div>
          ) : documents.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white py-12 text-center text-slate-500">
              No documents uploaded yet.
            </div>
          ) : (
            <div className="grid gap-4">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  onClick={() =>
                    openDocument(doc)
                  }
                  className={`flex items-center justify-between rounded-2xl border bg-white p-5 shadow-sm transition ${selectedDocIds.has(doc.id) ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200"} ${
                    doc.status === "PROCESSED"
                      ? "cursor-pointer hover:border-blue-300 hover:shadow-md"
                      : "cursor-default"
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-4">
                    {doc.status === "PROCESSED" && (
                      <input
                        type="checkbox"
                        checked={selectedDocIds.has(doc.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleDocumentSelection(doc.id);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="h-5 w-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      />
                    )}

                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-slate-50 text-xs font-bold uppercase text-slate-400">
                      {doc.mimeType.includes("pdf")
                        ? "PDF"
                        : "DOCX"}
                    </div>

                    <div className="min-w-0">
                      <h4 className="max-w-[200px] truncate font-semibold text-slate-900 sm:max-w-md">
                        {doc.name}
                      </h4>

                      <p className="mt-1 text-xs text-slate-500">
                        {(
                          doc.size /
                          1024 /
                          1024
                        ).toFixed(2)}{" "}
                        MB
                        {" • "}
                        {new Date(
                          doc.createdAt
                        ).toLocaleDateString()}
                        {" • "}

                        {doc.status === "PROCESSED" && (
                          <span className="font-medium text-emerald-600">
                            {doc.status}
                          </span>
                        )}
                        {doc.status === "PROCESSING" && (
                          <span className="font-medium text-amber-500 animate-pulse">
                            {doc.status}...
                          </span>
                        )}
                        {doc.status === "FAILED" && (
                          <span className="font-medium text-red-600">
                            {doc.status}
                          </span>
                        )}
                      </p>

                      {doc.status === "FAILED" && doc.errorMessage && (
                        <p className="mt-2 text-xs text-red-500 line-clamp-2">
                          {doc.errorMessage}
                        </p>
                      )}

                      {doc.status === "PROCESSED" && (
                        <p className="mt-2 text-xs font-medium text-blue-600">
                          Open contract →
                        </p>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDelete(doc.id);
                    }}
                    className="ml-4 rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-500"
                    title="Delete document"
                    aria-label={`Delete ${doc.name}`}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M3 6h18" />
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      <line
                        x1="10"
                        y1="11"
                        x2="10"
                        y2="17"
                      />
                      <line
                        x1="14"
                        y1="11"
                        x2="14"
                        y2="17"
                      />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Features */}
        <div className="mx-auto mt-20 grid max-w-3xl gap-5 sm:grid-cols-3">
          <Feature
            title="Verified quotes"
            description="Every citation is checked against the contract."
          />

          <Feature
            title="Ask questions"
            description="Chat naturally with uploaded legal documents."
          />

          <Feature
            title="Compare contracts"
            description="Find meaningful changes between contract versions."
          />
        </div>
      </section>
    </main>
  );
}

function Feature({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="font-semibold">{title}</h3>

      <p className="mt-2 text-sm leading-6 text-slate-500">
        {description}
      </p>
    </div>
  );
}
