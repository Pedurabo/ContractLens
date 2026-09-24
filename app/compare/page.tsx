"use client";

import { useEffect, useMemo, useState } from "react";

interface DocumentItem {
  id: string;
  name: string;
  originalName: string;
  status: string;
}

interface VerifiedQuote {
  documentId: string;
  documentName: string;
  quote: string;
  startChar: number;
  endChar: number;
  verified: boolean;
}

interface ComparisonItem {
  title: string;
  changeType: "MODIFIED" | "ONLY_A" | "ONLY_B";
  significance: "HIGH" | "MEDIUM" | "LOW";
  summary: string;
  reason: string;
  documentA: VerifiedQuote | null;
  documentB: VerifiedQuote | null;
}

interface CompareResult {
  documentA: {
    id: string;
    name: string;
  };

  documentB: {
    id: string;
    name: string;
  };

  comparisons: ComparisonItem[];

  stats: {
    total: number;
    high: number;
    medium: number;
    low: number;
  };
}

type SignificanceFilter =
  | "ALL"
  | "HIGH"
  | "MEDIUM"
  | "LOW";

type ChangeFilter =
  | "ALL"
  | "MODIFIED"
  | "ONLY_A"
  | "ONLY_B";

export default function ComparePage() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);

  const [documentIdA, setDocumentIdA] = useState("");
  const [documentIdB, setDocumentIdB] = useState("");

  const [result, setResult] = useState<CompareResult | null>(null);

  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [comparing, setComparing] = useState(false);

  const [error, setError] = useState("");

  const [significanceFilter, setSignificanceFilter] =
    useState<SignificanceFilter>("ALL");

  const [changeFilter, setChangeFilter] =
    useState<ChangeFilter>("ALL");

  useEffect(() => {
    loadDocuments();
  }, []);

  async function loadDocuments() {
    try {
      setLoadingDocuments(true);
      setError("");

      const response = await fetch("/api/documents");

      if (!response.ok) {
        throw new Error("Could not load documents.");
      }

      const data = await response.json();

      const rawDocuments: DocumentItem[] = Array.isArray(data)
        ? data
        : Array.isArray(data.value)
          ? data.value
          : [];

      const processed = rawDocuments.filter(
        (document) => document.status === "PROCESSED"
      );

      setDocuments(processed);
    } catch (err) {
      console.error(err);

      setError(
        err instanceof Error
          ? err.message
          : "Could not load documents."
      );
    } finally {
      setLoadingDocuments(false);
    }
  }

  async function compareDocuments() {
    if (!documentIdA || !documentIdB) {
      setError("Select two documents to compare.");
      return;
    }

    if (documentIdA === documentIdB) {
      setError("Please select two different documents.");
      return;
    }

    try {
      setComparing(true);
      setError("");
      setResult(null);

      setSignificanceFilter("ALL");
      setChangeFilter("ALL");

      const response = await fetch("/api/compare", {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          documentIdA,
          documentIdB,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Comparison failed."
        );
      }

      setResult(data);
    } catch (err) {
      console.error(err);

      setError(
        err instanceof Error
          ? err.message
          : "Comparison failed."
      );
    } finally {
      setComparing(false);
    }
  }

  const filteredComparisons = useMemo(() => {
    if (!result) {
      return [];
    }

    return result.comparisons.filter((item) => {
      const significanceMatches =
        significanceFilter === "ALL" ||
        item.significance === significanceFilter;

      const changeMatches =
        changeFilter === "ALL" ||
        item.changeType === changeFilter;

      return significanceMatches && changeMatches;
    });
  }, [
    result,
    significanceFilter,
    changeFilter,
  ]);

  function openQuote(quote: VerifiedQuote) {
    const params = new URLSearchParams({
      start: String(quote.startChar),
      end: String(quote.endChar),
    });

    window.open(
      `/documents/${quote.documentId}?${params.toString()}`,
      "_blank"
    );
  }

  function significanceClasses(
    significance: ComparisonItem["significance"]
  ) {
    if (significance === "HIGH") {
      return "border-red-200 bg-red-50 text-red-700";
    }

    if (significance === "MEDIUM") {
      return "border-amber-200 bg-amber-50 text-amber-700";
    }

    return "border-blue-200 bg-blue-50 text-blue-700";
  }

  function changeTypeLabel(
    changeType: ComparisonItem["changeType"]
  ) {
    if (changeType === "ONLY_A") {
      return "Only in A";
    }

    if (changeType === "ONLY_B") {
      return "Only in B";
    }

    return "Modified";
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <a
              href="/"
              className="mb-3 inline-flex text-sm font-medium text-slate-500 transition hover:text-slate-900"
            >
              ← Back to document library
            </a>

            <h1 className="text-3xl font-bold tracking-tight">
              Compare contracts
            </h1>

            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Compare two processed contracts clause by clause.
              ContractLens verifies every displayed quotation against
              the original extracted document text.
            </p>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <div className="font-semibold">
              Verified evidence
            </div>

            <div className="mt-1 text-xs text-emerald-700">
              Unverified quotations are not displayed.
            </div>
          </div>
        </div>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[1fr_auto_1fr] lg:items-end">
            <div>
              <label
                htmlFor="document-a"
                className="mb-2 block text-sm font-semibold text-slate-700"
              >
                Document A
              </label>

              <select
                id="document-a"
                value={documentIdA}
                disabled={loadingDocuments || comparing}
                onChange={(event) => {
                  setDocumentIdA(event.target.value);
                  setResult(null);
                  setError("");
                }}
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:bg-slate-100"
              >
                <option value="">
                  Select first contract
                </option>

                {documents.map((document) => (
                  <option
                    key={document.id}
                    value={document.id}
                    disabled={document.id === documentIdB}
                  >
                    {document.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="hidden pb-3 text-center text-xl text-slate-400 lg:block">
              ⇄
            </div>

            <div>
              <label
                htmlFor="document-b"
                className="mb-2 block text-sm font-semibold text-slate-700"
              >
                Document B
              </label>

              <select
                id="document-b"
                value={documentIdB}
                disabled={loadingDocuments || comparing}
                onChange={(event) => {
                  setDocumentIdB(event.target.value);
                  setResult(null);
                  setError("");
                }}
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 disabled:cursor-not-allowed disabled:bg-slate-100"
              >
                <option value="">
                  Select second contract
                </option>

                {documents.map((document) => (
                  <option
                    key={document.id}
                    value={document.id}
                    disabled={document.id === documentIdA}
                  >
                    {document.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-slate-500">
              {loadingDocuments
                ? "Loading document library..."
                : `${documents.length} processed document${
                    documents.length === 1 ? "" : "s"
                  } available`}
            </div>

            <button
              type="button"
              onClick={compareDocuments}
              disabled={
                comparing ||
                !documentIdA ||
                !documentIdB ||
                documentIdA === documentIdB
              }
              className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {comparing
                ? "Comparing contracts..."
                : "Compare contracts"}
            </button>
          </div>
        </section>

        {error && (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {comparing && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-800" />

            <h2 className="font-semibold">
              Comparing your contracts
            </h2>

            <p className="mt-2 text-sm text-slate-500">
              Matching clauses, analyzing substantive changes,
              and independently verifying quotations.
            </p>
          </section>
        )}

        {result && !comparing && (
          <>
            <section className="mt-6">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Total differences"
                  value={result.stats.total}
                />

                <StatCard
                  label="High significance"
                  value={result.stats.high}
                />

                <StatCard
                  label="Medium significance"
                  value={result.stats.medium}
                />

                <StatCard
                  label="Low significance"
                  value={result.stats.low}
                />
              </div>
            </section>

            <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">
                    Comparison results
                  </h2>

                  <p className="mt-1 text-sm text-slate-500">
                    {result.documentA.name}
                    {"  "}vs{"  "}
                    {result.documentB.name}
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                      Significance
                    </label>

                    <select
                      value={significanceFilter}
                      onChange={(event) =>
                        setSignificanceFilter(
                          event.target.value as SignificanceFilter
                        )
                      }
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="ALL">
                        All significance
                      </option>

                      <option value="HIGH">
                        High
                      </option>

                      <option value="MEDIUM">
                        Medium
                      </option>

                      <option value="LOW">
                        Low
                      </option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
                      Change type
                    </label>

                    <select
                      value={changeFilter}
                      onChange={(event) =>
                        setChangeFilter(
                          event.target.value as ChangeFilter
                        )
                      }
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="ALL">
                        All changes
                      </option>

                      <option value="MODIFIED">
                        Modified
                      </option>

                      <option value="ONLY_A">
                        Only in A
                      </option>

                      <option value="ONLY_B">
                        Only in B
                      </option>
                    </select>
                  </div>
                </div>
              </div>
            </section>

            <section className="mt-5 space-y-4">
              {filteredComparisons.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
                  <h3 className="font-semibold">
                    No differences match these filters
                  </h3>

                  <p className="mt-2 text-sm text-slate-500">
                    Try changing the significance or change-type
                    filter.
                  </p>
                </div>
              ) : (
                filteredComparisons.map((item, index) => (
                  <article
                    key={`${item.title}-${index}`}
                    className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
                  >
                    <div className="border-b border-slate-100 p-5 sm:p-6">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="mb-2 flex flex-wrap gap-2">
                            <span
                              className={`rounded-full border px-2.5 py-1 text-xs font-bold ${significanceClasses(
                                item.significance
                              )}`}
                            >
                              {item.significance}
                            </span>

                            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">
                              {changeTypeLabel(item.changeType)}
                            </span>
                          </div>

                          <h3 className="text-lg font-bold">
                            {item.title}
                          </h3>
                        </div>

                        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                          ✓ Verified evidence
                        </div>
                      </div>

                      <p className="mt-4 text-sm leading-6 text-slate-700">
                        {item.summary}
                      </p>

                      <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Why this matters
                        </div>

                        <p className="mt-1 text-sm leading-6 text-slate-700">
                          {item.reason}
                        </p>
                      </div>
                    </div>

                    <div className="grid lg:grid-cols-2">
                      <EvidencePanel
                        label="Document A"
                        documentName={result.documentA.name}
                        quote={item.documentA}
                        onOpen={openQuote}
                      />

                      <div className="border-t border-slate-200 lg:border-l lg:border-t-0">
                        <EvidencePanel
                          label="Document B"
                          documentName={result.documentB.name}
                          quote={item.documentB}
                          onOpen={openQuote}
                        />
                      </div>
                    </div>
                  </article>
                ))
              )}
            </section>

            {result.comparisons.length === 0 && (
              <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
                <div className="text-3xl">
                  ✓
                </div>

                <h2 className="mt-3 text-lg font-semibold">
                  No substantive differences found
                </h2>

                <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">
                  ContractLens did not return any verified substantive
                  differences for this comparison.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm text-slate-500">
        {label}
      </div>

      <div className="mt-2 text-3xl font-bold tracking-tight">
        {value}
      </div>
    </div>
  );
}

function EvidencePanel({
  label,
  documentName,
  quote,
  onOpen,
}: {
  label: string;
  documentName: string;
  quote: VerifiedQuote | null;
  onOpen: (quote: VerifiedQuote) => void;
}) {
  return (
    <div className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">
            {label}
          </div>

          <div className="mt-1 break-words text-sm font-semibold text-slate-800">
            {documentName}
          </div>
        </div>

        {quote?.verified && (
          <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
            Verified
          </span>
        )}
      </div>

      {quote ? (
        <>
          <blockquote className="mt-4 border-l-4 border-slate-300 pl-4 text-sm leading-6 text-slate-700">
            “{quote.quote}”
          </blockquote>

          <button
            type="button"
            onClick={() => onOpen(quote)}
            className="mt-4 inline-flex rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Open in document →
          </button>
        </>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
          No corresponding clause in this document.
        </div>
      )}
    </div>
  );
}