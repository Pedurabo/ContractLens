import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { gemini, GEMINI_MODEL } from "@/lib/gemini";

export const runtime = "nodejs";

const MAX_ROUNDS = 6;
const MAX_SEARCH_RESULTS = 5;
const MAX_SECTION_LENGTH = 5000;
const MAX_HISTORY_LENGTH = 14000;

type ResearchToolName =
| "list_clauses"
| "search_document"
| "get_section";

type ToolCall = {
tool: ResearchToolName;
args?: Record<string, unknown>;
};

type FinalDecision = {
final: true;
answer: string;
quotes?: string[];
};

type AgentDecision = ToolCall | FinalDecision;

type VerifiedCitation = {
quote: string;
startChar: number;
endChar: number;
pageNumber: number | null;
};

type Chunk = {
id: string;
content: string;
chunkIndex: number;
startChar: number;
endChar: number;
pageNumber: number | null;
};

type EvidenceItem = {
tool: ResearchToolName;
content: string;
};

function normalizeForSearch(value: string) {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTerms(value: string) {
  const stopWords = new Set([
    "the",
    "and",
    "that",
    "this",
    "with",
    "from",
    "into",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "how",
    "does",
    "are",
    "was",
    "were",
    "will",
    "would",
    "could",
    "should",
    "have",
    "has",
    "had",
    "for",
    "its",
    "their",
    "there",
    "about",
    "under",
    "between",
    "document",
    "contract",
    "agreement",
    "please",
    "tell",
    "explain",
  ]);

  return Array.from(
    new Set(
      normalizeForSearch(value)
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !stopWords.has(word))
)
);
}

function buildNormalizedMap(text: string) {
  let normalized = "";
  const map: number[] = [];

  let previousWasWhitespace = true;

  for (let i = 0; i < text.length; i++) {
    const original = text[i];
    const isWhitespace = /\s/.test(original);

    if (isWhitespace) {
      if (!previousWasWhitespace && normalized.length > 0) {
        normalized += " ";
        map.push(i);
      }

      previousWasWhitespace = true;
      continue;
    }

    let char = original;

    if (char === "\u2018" || char === "\u2019") {
      char = "'";
    } else if (char === "\u201c" || char === "\u201d") {
      char = '"';
    }

    normalized += char.toLowerCase();
    map.push(i);
    previousWasWhitespace = false;
  }

  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    map.pop();
  }

  return {
    normalized,
    map,
  };
}

function findQuoteOffsets(
  documentText: string,
  candidateQuote: string
): {
  startChar: number;
  endChar: number;
} | null {
  const quote = candidateQuote.trim();

  if (!quote) {
    return null;
  }

  const exactIndex = documentText.indexOf(quote);

  if (exactIndex !== -1) {
    return {
      startChar: exactIndex,
      endChar: exactIndex + quote.length,
    };
  }

  const lowerDocument = documentText.toLowerCase();
  const lowerQuote = quote.toLowerCase();
  const caseInsensitiveIndex = lowerDocument.indexOf(lowerQuote);

  if (caseInsensitiveIndex !== -1) {
    return {
      startChar: caseInsensitiveIndex,
      endChar: caseInsensitiveIndex + quote.length,
    };
  }

  const documentMap = buildNormalizedMap(documentText);
  const quoteMap = buildNormalizedMap(quote);

  if (!quoteMap.normalized) {
    return null;
  }

  const normalizedIndex = documentMap.normalized.indexOf(
    quoteMap.normalized
  );

  if (normalizedIndex === -1) {
    return null;
  }

  const normalizedEnd =
    normalizedIndex + quoteMap.normalized.length - 1;

  const startChar = documentMap.map[normalizedIndex];
  const finalMappedCharacter = documentMap.map[normalizedEnd];

  if (
    startChar === undefined ||
    finalMappedCharacter === undefined
  ) {
    return null;
  }

  return {
    startChar,
    endChar: finalMappedCharacter + 1,
  };
}

function pageForOffset(chunks: Chunk[], startChar: number) {
  const containingChunk = chunks.find(
    (chunk) =>
      startChar >= chunk.startChar &&
      startChar < chunk.endChar
  );

  return containingChunk?.pageNumber ?? null;
}

function verifyQuote(
  documentText: string,
  chunks: Chunk[],
  quote: string
): VerifiedCitation | null {
  const offsets = findQuoteOffsets(documentText, quote);

  if (!offsets) {
    return null;
  }

  return {
    quote: documentText.slice(
      offsets.startChar,
      offsets.endChar
    ),
    startChar: offsets.startChar,
    endChar: offsets.endChar,
    pageNumber: pageForOffset(
      chunks,
      offsets.startChar
    ),
  };
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with fenced/object extraction.
  }

  const fenced =
    trimmed.match(/```json\s*([\s\S]*?)```/i) ??
    trimmed.match(/```\s*([\s\S]*?)```/);

  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue.
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (
    firstBrace !== -1 &&
    lastBrace > firstBrace
  ) {
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      );
    } catch {
      return null;
    }
  }

  return null;
}

function isToolName(
  value: unknown
): value is ResearchToolName {
  return (
    value === "list_clauses" ||
    value === "search_document" ||
    value === "get_section"
  );
}

function parseDecision(raw: string): AgentDecision | null {
  const parsed = extractJsonObject(raw);

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (
    parsed.final === true &&
    typeof parsed.answer === "string"
  ) {
    return {
      final: true,
      answer: parsed.answer,
      quotes: Array.isArray(parsed.quotes)
        ? parsed.quotes.filter(
            (quote: unknown): quote is string =>
              typeof quote === "string"
)
: [],
};
}

if (isToolName(parsed.tool)) {
    return {
      tool: parsed.tool,
      args:
        parsed.args &&
        typeof parsed.args === "object"
          ? parsed.args
          : {},
    };
  }

  return null;
}

function truncate(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n...[truncated]`;
}

function splitIntoSentences(text: string) {
  return text
    .replace(/\r/g, "")
    .split(
      /(?<=[.!?;])\s+|\n{2,}/
)
.map((part) => part.trim())
    .filter(Boolean);
}

function bestEvidenceQuote(
  documentText: string,
  question: string,
  evidence: EvidenceItem[]
) {
  const terms = meaningfulTerms(question);

  let best:
    | {
        sentence: string;
        score: number;
      }
    | undefined;

  for (const item of evidence) {
    const sentences = splitIntoSentences(
      item.content
    );

    for (const sentence of sentences) {
      if (
        sentence.length < 25 ||
        sentence.length > 700
      ) {
        continue;
      }

      const normalized =
        normalizeForSearch(sentence);

      let score = 0;

      for (const term of terms) {
        if (normalized.includes(term)) {
          score += 1;
        }
      }

      if (
        !best ||
        score > best.score
      ) {
        best = {
          sentence,
          score,
        };
      }
    }
  }

  if (!best) {
    return null;
  }

  const verified = findQuoteOffsets(
    documentText,
    best.sentence
  );

  if (!verified) {
    return null;
  }

  return documentText.slice(
    verified.startChar,
    verified.endChar
  );
}

function detectClauseHeadings(text: string) {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const results: {
    heading: string;
    startChar: number;
  }[] = [];

  let searchFrom = 0;

  for (const line of lines) {
    const looksNumbered =
      /^(\d+(\.\d+)*|[A-Z])[\).\s:-]+/.test(
        line
      );

    const looksUppercase =
      line.length >= 3 &&
      line.length <= 100 &&
      /[A-Z]/.test(line) &&
      line === line.toUpperCase();

    const looksTitle =
      line.length <= 100 &&
      /^[A-Z][A-Za-z0-9 &'(),./-]{2,}$/.test(
        line
      ) &&
      line.split(/\s+/).length <= 12;

    if (
      !looksNumbered &&
      !looksUppercase &&
      !looksTitle
    ) {
      continue;
    }

    const index = text.indexOf(line, searchFrom);

    if (index !== -1) {
      results.push({
        heading: line,
        startChar: index,
      });

      searchFrom = index + line.length;
    }

    if (results.length >= 80) {
      break;
    }
  }

  return results;
}

function searchChunks(
  chunks: Chunk[],
  query: string
) {
  const terms = meaningfulTerms(query);

  if (terms.length === 0) {
    return chunks
      .slice(0, MAX_SEARCH_RESULTS)
      .map((chunk) => ({
        ...chunk,
        score: 0,
      }));
  }

  return chunks
    .map((chunk) => {
      const normalized =
        normalizeForSearch(chunk.content);

      let score = 0;

      for (const term of terms) {
        const escaped = term.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

        const matches =
          normalized.match(
            new RegExp(escaped, "g")
          ) ?? [];

        score += matches.length * 2;

        if (normalized.includes(term)) {
          score += 1;
        }
      }

      return {
        ...chunk,
        score,
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, MAX_SEARCH_RESULTS);
}

function getSection(
  documentText: string,
  chunks: Chunk[],
  args: Record<string, unknown>
) {
  const startChar =
    typeof args.startChar === "number"
      ? Math.max(
          0,
          Math.floor(args.startChar)
)
: null;

if (startChar !== null) {
    const requestedLength =
      typeof args.length === "number"
        ? Math.floor(args.length)
        : MAX_SECTION_LENGTH;

    const length = Math.min(
      Math.max(requestedLength, 500),
      MAX_SECTION_LENGTH
    );

    const endChar = Math.min(
      documentText.length,
      startChar + length
    );

    return {
      content: documentText.slice(
        startChar,
        endChar
      ),
      startChar,
      endChar,
    };
  }

  const query =
    typeof args.query === "string"
      ? args.query.trim()
      : "";

  if (!query) {
    return {
      content: "",
      startChar: 0,
      endChar: 0,
      error:
        "get_section requires either startChar or query.",
    };
  }

  const matches = searchChunks(
    chunks,
    query
  );

  if (matches.length === 0) {
    return {
      content: "",
      startChar: 0,
      endChar: 0,
      error:
        "No matching section was found.",
    };
  }

  const best = matches[0];

  const padding = 700;

  const sectionStart = Math.max(
    0,
    best.startChar - padding
  );

  const sectionEnd = Math.min(
    documentText.length,
    best.endChar + padding
  );

  const cappedEnd = Math.min(
    sectionEnd,
    sectionStart + MAX_SECTION_LENGTH
  );

  return {
    content: documentText.slice(
      sectionStart,
      cappedEnd
    ),
    startChar: sectionStart,
    endChar: cappedEnd,
  };
}

async function askAgent(prompt: string) {
  const models = Array.from(
    new Set([
      GEMINI_MODEL,
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash-lite",
    ])
  );

  let lastError: unknown = null;

  for (const model of models) {
    try {
      const response = await Promise.race([
        gemini.models.generateContent({
          model,
          contents: prompt,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(
              Object.assign(
                new Error(`Gemini request timed out for ${model}.`),
                { status: 504 }
              )
            ),
            20000
          )
        ),
      ]);

      return response.text ?? "";
    } catch (error: any) {
      lastError = error;
      const status = Number(
        error?.status || error?.code || 0
      );

      if (
        ![429, 500, 502, 503, 504].includes(status)
      ) {
        throw error;
      }

      console.warn(
        `[Research] ${model} unavailable (${status}); trying fallback.`
      );
    }
  }

  throw (
    lastError ||
    new Error("No Gemini model is currently available.")
  );
}

function buildAgentPrompt({
  documentName,
  question,
  round,
  history,
}: {
  documentName: string;
  question: string;
  round: number;
  history: string;
}) {
  return `
You are the research agent inside ContractLens.

You must answer ONLY from the supplied contract by using the available document tools.

DOCUMENT:
${documentName}

USER QUESTION:
${question}

CURRENT ROUND:
${round} of ${MAX_ROUNDS}

AVAILABLE TOOLS:

1. list_clauses
Arguments:
{}

Purpose:
Inspect the contract structure and identify likely clause headings.

2. search_document
Arguments:
{
  "query": "search words or phrase"
}

Purpose:
Search across ALL stored document chunks and return the most relevant passages.

3. get_section
Arguments:
{
  "query": "clause heading or subject"
}

OR:

{
  "startChar": 1000,
  "length": 3500
}

Purpose:
Read a larger surrounding section after locating relevant material.

RESEARCH RULES:

- You are operating in a real multi-round tool loop.
- Decide what to inspect next based on previous tool results.
- Do not invent contract facts.
- Do not invent page numbers or character positions.
- The server independently verifies every quotation.
- Prefer search_document for locating substantive terms.
- Use get_section when surrounding context is needed.
- list_clauses is useful for understanding structure, but headings alone are not enough to prove substantive facts.
- Do not repeat the exact same tool call.
- Usually 2 to 4 useful tool calls are enough.
- Finish as soon as you have enough evidence.
- If the requested information cannot be established from the retrieved evidence, clearly say that.
- If only part of the document has been substantively inspected, do NOT claim that something is absent from the entire contract.
- Quotes must be copied VERBATIM from tool results.
- Keep the final answer concise and directly responsive.

PREVIOUS RESEARCH:
${history || "(No tools have been used yet.)"}

OUTPUT EXACTLY ONE JSON OBJECT.

To use a tool:

{
  "tool": "search_document",
  "args": {
    "query": "termination notice"
  }
}

To finish:

{
  "final": true,
  "answer": "Your grounded answer here.",
  "quotes": [
    "Exact verbatim supporting quotation from the document"
  ]
}

Do not output markdown fences.
Do not output commentary outside the JSON object.
`.trim();
}

function serializeToolResult(
  tool: ResearchToolName,
  args: Record<string, unknown>,
  result: unknown
) {
  return truncate(
    JSON.stringify(
      {
        tool,
        args,
        result,
      },
      null,
      2
    ),
    7000
  );
}

export async function POST(
  request: NextRequest
) {
  try {
    const body = await request.json();

    const documentId =
      typeof body?.documentId === "string"
        ? body.documentId.trim()
        : "";

    const question =
      typeof body?.question === "string"
        ? body.question.trim()
        : "";

    if (!documentId || !question) {
      return Response.json(
        {
          error:
            "documentId and question are required.",
        },
        {
          status: 400,
        }
      );
    }

    const document =
      await prisma.document.findUnique({
        where: {
          id: documentId,
        },
        include: {
          chunks: {
            orderBy: {
              chunkIndex: "asc",
            },
          },
        },
      });

    if (!document) {
      return Response.json(
        {
          error: "Document not found.",
        },
        {
          status: 404,
        }
      );
    }

    if (document.status !== "PROCESSED") {
      return Response.json(
        {
          error:
            "This document has not finished processing.",
        },
        {
          status: 400,
        }
      );
    }

    if (!document.extractedText.trim()) {
      return Response.json(
        {
          error:
            "This document contains no readable extracted text.",
        },
        {
          status: 400,
        }
      );
    }

    const chunks: Chunk[] =
      document.chunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
        pageNumber: chunk.pageNumber,
      }));

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let streamClosed = false;

        const send = (
          data: unknown
        ): boolean => {
          if (streamClosed) {
            return false;
          }

          try {
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify(data)}\n`
)
);

return true;
} catch {
streamClosed = true;

console.warn(
              "[Research stream] Client connection is no longer writable."
            );

            return false;
          }
        };

        const closeStream = () => {
          if (streamClosed) {
            return;
          }

          try {
            controller.close();
          } catch {
            // Browser/client may already have
            // closed the response stream.
          } finally {
            streamClosed = true;
          }
        };

        const abortHandler = () => {
          streamClosed = true;
        };

        request.signal.addEventListener(
          "abort",
          abortHandler
        );

        try {
          send({
            type: "status",
            message:
              "Starting document research...",
          });

          const historyParts: string[] = [];
          const evidence: EvidenceItem[] = [];
          const usedCalls = new Set<string>();

          let finalAnswer = "";
          let candidateQuotes: string[] = [];
          let roundsCompleted = 0;

          for (
            let round = 1;
            round <= MAX_ROUNDS;
            round++
          ) {
            if (streamClosed) {
              return;
            }

            roundsCompleted = round;

            send({
              type: "status",
              message: `Research round ${round} of ${MAX_ROUNDS}...`,
            });

            const history = truncate(
              historyParts.join("\n\n"),
              MAX_HISTORY_LENGTH
            );

            const prompt = buildAgentPrompt({
              documentName:
                document.originalName ||
                document.name,
              question,
              round,
              history,
            });

            let rawDecision = "";

            try {
              rawDecision =
                await askAgent(prompt);
            } catch (error: any) {
              throw new Error(
                error?.message ||
                  "The AI provider failed during research."
              );
            }

            if (streamClosed) {
              return;
            }

            const decision =
              parseDecision(rawDecision);

            if (!decision) {
              historyParts.push(
                [
                  `ROUND ${round} MALFORMED RESPONSE:`,
                  truncate(rawDecision, 2500),
                  "",
                  "SYSTEM FEEDBACK:",
                  "Your previous response was malformed. Return exactly one valid JSON object using either a tool call or the final-answer schema.",
                ].join("\n")
              );

              send({
                type: "activity",
                round,
                tool: "system",
                message:
                  "The agent returned a malformed instruction. Asking it to correct the format.",
              });

              continue;
            }

            if ("final" in decision) {
              finalAnswer =
                decision.answer.trim();

              candidateQuotes =
                decision.quotes ?? [];

              send({
                type: "activity",
                round,
                tool: "final",
                message:
                  "The agent has enough evidence and is preparing the grounded answer.",
              });

              break;
            }

            const tool = decision.tool;
            const args =
              decision.args ?? {};

            const callKey = JSON.stringify({
              tool,
              args,
            });

            if (usedCalls.has(callKey)) {
              historyParts.push(
                [
                  `ROUND ${round}:`,
                  `Duplicate tool call rejected: ${callKey}`,
                  "Choose a different search, section, or finish with the evidence already collected.",
                ].join("\n")
              );

              send({
                type: "activity",
                round,
                tool,
                message:
                  "Duplicate tool call prevented. The agent will choose another research step.",
              });

              continue;
            }

            usedCalls.add(callKey);

            if (tool === "list_clauses") {
              send({
                type: "activity",
                round,
                tool,
                message:
                  "Reviewing the contract structure...",
              });

              const headings =
                detectClauseHeadings(
                  document.extractedText
                );

              const result = {
                clauseCount:
                  headings.length,
                clauses: headings.map(
                  (heading, index) => ({
                    index: index + 1,
                    heading:
                      heading.heading,
                    startChar:
                      heading.startChar,
                  })
                ),
                note:
                  "This tool scans the document for likely headings. Headings alone do not establish the substantive contents of a clause.",
              };

              historyParts.push(
                serializeToolResult(
                  tool,
                  args,
                  result
)
);

evidence.push({
                tool,
                content: headings
                  .map(
                    (heading) =>
                      heading.heading
)
.join("\n"),
              });

              send({
                type: "activity",
                round,
                tool,
                message: `Found ${headings.length} possible clause headings.`,
              });

              continue;
            }

            if (tool === "search_document") {
              const query =
                typeof args.query ===
                "string"
                  ? args.query.trim()
                  : "";

              if (!query) {
                historyParts.push(
                  serializeToolResult(
                    tool,
                    args,
                    {
                      error:
                        "search_document requires a non-empty query.",
                    }
)
);

send({
                  type: "activity",
                  round,
                  tool,
                  message:
                    "The search request was malformed, so the agent will try again.",
                });

                continue;
              }

              send({
                type: "activity",
                round,
                tool,
                message: `Searching the document for "${query}"...`,
              });

              const matches =
                searchChunks(
                  chunks,
                  query
                );

              const result = {
                query,
                searchedChunkCount:
                  chunks.length,
                resultCount:
                  matches.length,
                results: matches.map(
                  (match) => ({
                    chunkIndex:
                      match.chunkIndex,
                    startChar:
                      match.startChar,
                    endChar:
                      match.endChar,
                    content:
                      truncate(
                        match.content,
                        2600
                      ),
                  })
                ),
              };

              historyParts.push(
                serializeToolResult(
                  tool,
                  args,
                  result
)
);

for (const match of matches) {
                evidence.push({
                  tool,
                  content:
                    match.content,
                });
              }

              send({
                type: "activity",
                round,
                tool,
                message:
                  matches.length > 0
                    ? `Found ${matches.length} relevant passage${matches.length === 1 ? "" : "s"}.`
                    : "No matching passages were found for that search.",
              });

              continue;
            }

            if (tool === "get_section") {
              send({
                type: "activity",
                round,
                tool,
                message:
                  "Reading the surrounding contract section...",
              });

              const result =
                getSection(
                  document.extractedText,
                  chunks,
                  args
                );

              historyParts.push(
                serializeToolResult(
                  tool,
                  args,
                  result
)
);

if (result.content) {
                evidence.push({
                  tool,
                  content:
                    result.content,
                });
              }

              send({
                type: "activity",
                round,
                tool,
                message:
                  result.content
                    ? "Loaded the surrounding section."
                    : "The requested section could not be located.",
              });

              continue;
            }
          }

          if (streamClosed) {
            return;
          }

          /*
           * If the agent used all rounds without explicitly
           * returning a final answer, make one final synthesis
           * request using only the evidence already gathered.
           */
          if (!finalAnswer) {
            send({
              type: "status",
              message:
                "Synthesizing the research findings...",
            });

            const evidenceText = truncate(
              historyParts.join("\n\n"),
              MAX_HISTORY_LENGTH
            );

            const finalPrompt = `
You are completing a ContractLens document research task.

DOCUMENT:
${document.originalName || document.name}

QUESTION:
${question}

RESEARCH RESULTS:
${evidenceText || "(No useful evidence was retrieved.)"}

Write the final answer using ONLY the research results above.

Rules:
- Do not invent facts.
- Do not claim the whole document lacks something unless the research actually establishes that.
- If the evidence is insufficient, say so clearly.
- Quotes must be copied VERBATIM from the research results.
- Keep the answer concise.
- Return exactly one JSON object.
- Do not use markdown fences.

Required format:

{
  "final": true,
  "answer": "Grounded answer",
  "quotes": [
    "Exact supporting quotation"
  ]
}
`.trim();

            try {
              const rawFinal =
                await askAgent(
                  finalPrompt
                );

              if (streamClosed) {
                return;
              }

              const parsedFinal =
                parseDecision(rawFinal);

              if (
                parsedFinal &&
                "final" in parsedFinal
              ) {
                finalAnswer =
                  parsedFinal.answer.trim();

                candidateQuotes =
                  parsedFinal.quotes ?? [];
              }
            } catch (error) {
              console.error(
                "[Research final synthesis error]:",
                error
              );
            }
          }

          if (!finalAnswer) {
            if (evidence.length > 0) {
              finalAnswer =
                "I found potentially relevant contract text, but I could not produce a reliable final answer from the research steps completed.";
            } else {
              finalAnswer =
                "I could not find enough evidence in the retrieved contract material to answer this question reliably.";
            }
          }

          /*
           * Independent citation verification.
           *
           * The model's quotation is NEVER trusted merely
           * because the model returned it.
           */
          const verifiedCitations: VerifiedCitation[] =
            [];

          const seenCitationRanges =
            new Set<string>();

          for (const quote of candidateQuotes) {
            const verified =
              verifyQuote(
                document.extractedText,
                chunks,
                quote
              );

            if (!verified) {
              continue;
            }

            const key =
              `${verified.startChar}:${verified.endChar}`;

            if (
              seenCitationRanges.has(key)
            ) {
              continue;
            }

            seenCitationRanges.add(key);

            verifiedCitations.push(
              verified
            );
          }

          /*
           * If Gemini produced a useful answer but its quote
           * formatting prevented verification, choose a
           * relevant sentence from actual retrieved evidence
           * and independently verify that sentence too.
           */
          if (
            verifiedCitations.length === 0 &&
            evidence.length > 0
          ) {
            const fallbackQuote =
              bestEvidenceQuote(
                document.extractedText,
                question,
                evidence
              );

            if (fallbackQuote) {
              const verified =
                verifyQuote(
                  document.extractedText,
                  chunks,
                  fallbackQuote
                );

              if (verified) {
                verifiedCitations.push(
                  verified
                );
              }
            }
          }

          /*
           * A positive factual answer should not masquerade as
           * fully grounded when no quotation can be verified.
           */
          if (
            verifiedCitations.length === 0
          ) {
            finalAnswer =
              "I could not produce a verified answer from the document. The research process did not yield a supporting quotation that could be independently matched to the extracted contract text.";
          }

          /*
           * We intentionally keep this false. The research
           * tools may search all chunks for terms, but that is
           * not equivalent to substantively reading every part
           * of a large contract. This prevents false claims of
           * whole-document absence.
           */
          const fullDocumentCoverage = false;

          send({
            type: "final",
            documentId: document.id,
            documentName:
              document.originalName ||
              document.name,
            question,
            answer: finalAnswer,
            citations:
              verifiedCitations.map(
                (citation) => ({
                  documentId:
                    document.id,
                  documentName:
                    document.originalName ||
                    document.name,
                  quote:
                    citation.quote,
                  verified: true,
                  startChar:
                    citation.startChar,
                  endChar:
                    citation.endChar,
                  pageNumber:
                    citation.pageNumber,
                })
              ),
            roundsCompleted,
            maxRounds: MAX_ROUNDS,
            fullDocumentCoverage,
          });

          closeStream();
        } catch (error: any) {
          console.error(
            "[Research stream error]:",
            error
          );

          if (!streamClosed) {
            send({
              type: "error",
              error:
                error?.message ||
                "The research request failed unexpectedly.",
            });
          }

          closeStream();
        } finally {
          request.signal.removeEventListener(
            "abort",
            abortHandler
          );
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type":
          "application/x-ndjson; charset=utf-8",
        "Cache-Control":
          "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error: any) {
    console.error(
      "[Research route error]:",
      error
    );

    return Response.json(
      {
        error:
          error?.message ||
          "Unable to start document research.",
      },
      {
        status: 500,
      }
    );
  }
}