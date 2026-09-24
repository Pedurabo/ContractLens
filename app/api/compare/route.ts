import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { gemini, GEMINI_MODEL } from "../../../lib/gemini";

const STOPWORDS = new Set([
"the",
"and",
"a",
"of",
"to",
"is",
"in",
"it",
"that",
"on",
"for",
"with",
"as",
"by",
"at",
"an",
"be",
"this",
"which",
"or",
"from",
"are",
"was",
"were",
"but",
"not",
"have",
"has",
"can",
"will",
"would",
"should",
"their",
"they",
"who",
"what",
"how",
"where",
"when",
]);

const LEGAL_BOILERPLATE = new Set([
"agreement",
"party",
"parties",
"shall",
"hereof",
"thereto",
"herein",
"provision",
"provisions",
"section",
"article",
"clause",
"contract",
"document",
"hereunder",
"forth",
"forthwith",
"pursuant",
"including",
"limited",
"connection",
]);

function getMeaningfulTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter(
        (word) =>
          word.length > 2 &&
          !STOPWORDS.has(word) &&
          !LEGAL_BOILERPLATE.has(word)
)
);
}

function findQuoteOffsets(
  fullText: string,
  quote: string
): { startChar: number; endChar: number } | null {
  let trimmedQuote = quote.trim();

  trimmedQuote = trimmedQuote
    .replace(/^["'“'‘]|["'”'’]$/g, "")
    .trim();

  if (!trimmedQuote || trimmedQuote.length < 5) {
    return null;
  }

  // First: strict case-insensitive literal match.
  const lowerFull = fullText.toLowerCase();
  const lowerQuote = trimmedQuote.toLowerCase();

  const exactIdx = lowerFull.indexOf(lowerQuote);

  if (exactIdx !== -1) {
    return {
      startChar: exactIdx,
      endChar: exactIdx + trimmedQuote.length,
    };
  }

  // Second: whitespace-tolerant matching only.
  // Punctuation still remains significant.
  const escaped = trimmedQuote.replace(
    /[-\/\\^$*+?.()|[\]{}]/g,
    "\\$&"
  );

  const regexStr = escaped.replace(/\s+/g, "\\s+");

  try {
    const regex = new RegExp(regexStr, "i");
    const match = fullText.match(regex);

    if (match && match.index !== undefined) {
      return {
        startChar: match.index,
        endChar: match.index + match[0].length,
      };
    }
  } catch (error) {
    console.error(
      "[Comparison] Regex verification error:",
      error
    );
  }

  return null;
}

interface DocumentUnit {
  text: string;
  startChar: number;
  endChar: number;
  terms: Set<string>;
}

function splitIntoUnits(text: string): DocumentUnit[] {
  const units: DocumentUnit[] = [];

  const regex = /\n\s*\n/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  let pendingHeading: {
    text: string;
    start: number;
  } | null = null;

  const processBlock = (
    rawText: string,
    start: number,
    end: number
  ) => {
    const trimmed = rawText.trim();

    if (trimmed.length < 5) {
      return;
    }

    // Detect likely headings.
    //
    // This handles DOCX extraction where a heading such as:
    //
    // 2. PAYMENT TERMS
    //
    // can be separated from its body paragraph.
    const isHeading =
      trimmed.length < 80 &&
      !trimmed.includes("\n") &&
      (
        /^[0-9A-Z]+[\.\)]/.test(trimmed) ||
        /^[A-Z\s]{4,}$/.test(trimmed) ||
        trimmed.split(/\s+/).length < 5
      );

    if (isHeading) {
      if (pendingHeading !== null) {
        const previousHeading = pendingHeading as {
          text: string;
          start: number;
        };

        units.push({
          text: previousHeading.text,
          startChar: previousHeading.start,
          endChar: start,
          terms: getMeaningfulTerms(previousHeading.text),
        });
      }

      pendingHeading = {
        text: trimmed,
        start,
      };

      return;
    }

    let finalContent = trimmed;
    let finalStart = start;

    if (pendingHeading !== null) {
      const heading = pendingHeading as {
        text: string;
        start: number;
      };

      finalContent = heading.text + "\n" + trimmed;
      finalStart = heading.start;

      pendingHeading = null;
    }

    units.push({
      text: finalContent,
      startChar: finalStart,
      endChar: end,
      terms: getMeaningfulTerms(finalContent),
    });
  };

  while ((match = regex.exec(text)) !== null) {
    processBlock(
      text.substring(lastIndex, match.index),
      lastIndex,
      match.index
    );

    lastIndex = regex.lastIndex;
  }

  processBlock(
    text.substring(lastIndex),
    lastIndex,
    text.length
  );

  // TypeScript-safe final pending heading handling.
  const finalPendingHeading = pendingHeading as {
    text: string;
    start: number;
  } | null;

  if (finalPendingHeading !== null) {
    units.push({
      text: finalPendingHeading.text,
      startChar: finalPendingHeading.start,
      endChar: text.length,
      terms: getMeaningfulTerms(finalPendingHeading.text),
    });
  }

  return units.filter(
    (unit) => unit.text.length > 20
  );
}

function getSimilarity(
  setA: Set<string>,
  setB: Set<string>
): number {
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }

  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const term of setA) {
    if (setB.has(term)) {
      intersection++;
    }
  }

  return intersection / Math.max(
    setA.size,
    setB.size
  );
}

function getHeading(text: string): string {
  const firstLine = text
    .split("\n")[0]
    .trim();

  return firstLine
    .replace(
      /^([0-9]+|[a-zA-Z])[\.\)]\s*/,
      ""
)
.toLowerCase();
}

function normalizeHeading(
  heading: string
): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function headingSimilarity(
  headingA: string,
  headingB: string
): number {
  const normalizedA =
    normalizeHeading(headingA);

  const normalizedB =
    normalizeHeading(headingB);

  if (!normalizedA || !normalizedB) {
    return 0;
  }

  if (normalizedA === normalizedB) {
    return 1;
  }

  const termsA =
    getMeaningfulTerms(normalizedA);

  const termsB =
    getMeaningfulTerms(normalizedB);

  return getSimilarity(termsA, termsB);
}

function normalizeForEquality(
  text: string
): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(
  request: NextRequest
) {
  try {
    const body = await request.json();

    const {
      documentIdA,
      documentIdB,
    } = body;

    if (!documentIdA || !documentIdB) {
      return NextResponse.json(
        {
          error:
            "Both documentIdA and documentIdB are required.",
        },
        {
          status: 400,
        }
      );
    }

    if (documentIdA === documentIdB) {
      return NextResponse.json(
        {
          error:
            "Documents must be different.",
        },
        {
          status: 400,
        }
      );
    }

    const [docA, docB] =
      await Promise.all([
        prisma.document.findUnique({
          where: {
            id: documentIdA,
          },
        }),

        prisma.document.findUnique({
          where: {
            id: documentIdB,
          },
        }),
      ]);

    if (!docA || !docB) {
      return NextResponse.json(
        {
          error:
            "One or both documents not found.",
        },
        {
          status: 404,
        }
      );
    }

    if (
      docA.status !== "PROCESSED" ||
      docB.status !== "PROCESSED"
    ) {
      return NextResponse.json(
        {
          error:
            "Both documents must be in PROCESSED status.",
        },
        {
          status: 400,
        }
      );
    }

    const unitsA =
      splitIntoUnits(docA.extractedText);

    const unitsB =
      splitIntoUnits(docB.extractedText);

    const candidatePairs: {
      unitA: DocumentUnit | null;
      unitB: DocumentUnit | null;
      score: number;
    }[] = [];

    // Enforce one-to-one matching.
    const usedB = new Set<number>();

    /*
     * Match clauses from Document A
     * against Document B.
     *
     * A clause is NOT automatically paired
     * with the highest scoring B clause.
     *
     * It must pass MATCH_THRESHOLD.
     */
    for (
      let i = 0;
      i < unitsA.length;
      i++
    ) {
      const unitA = unitsA[i];

      const headingA =
        getHeading(unitA.text);

      let bestMatchIdx = -1;
      let bestScore = 0;

      for (
        let j = 0;
        j < unitsB.length;
        j++
      ) {
        if (usedB.has(j)) {
          continue;
        }

        const unitB = unitsB[j];

        const headingB =
          getHeading(unitB.text);

        const contentScore =
          getSimilarity(
            unitA.terms,
            unitB.terms
          );

        const headingScore =
          headingSimilarity(
            headingA,
            headingB
          );

        let combinedScore =
          contentScore;

        /*
         * Matching headings are strong
         * evidence that two clauses correspond.
         */
        if (headingScore === 1) {
          combinedScore = Math.max(
            combinedScore,
            1.5
          );
        } else if (
          headingScore >= 0.6
        ) {
          combinedScore = Math.max(
            combinedScore,
            0.9
          );
        }

        if (
          combinedScore > bestScore
        ) {
          bestScore =
            combinedScore;

          bestMatchIdx = j;
        }
      }

      /*
       * This prevents unrelated clauses such as
       * FORCE MAJEURE and CONFIDENTIALITY from
       * being forced together.
       */
      const MATCH_THRESHOLD = 0.45;

      if (
        bestMatchIdx !== -1 &&
        bestScore >= MATCH_THRESHOLD
      ) {
        candidatePairs.push({
          unitA,
          unitB:
            unitsB[bestMatchIdx],
          score: bestScore,
        });

        usedB.add(bestMatchIdx);
      } else {
        candidatePairs.push({
          unitA,
          unitB: null,
          score: 0,
        });
      }
    }

    /*
     * Anything remaining in Document B
     * becomes an ONLY_B candidate.
     */
    for (
      let j = 0;
      j < unitsB.length;
      j++
    ) {
      if (!usedB.has(j)) {
        candidatePairs.push({
          unitA: null,
          unitB: unitsB[j],
          score: 0,
        });
      }
    }

    /*
     * Remove only genuinely unchanged clauses.
     *
     * We deliberately do NOT use term similarity
     * here because changes such as:
     *
     * 30 days -> 15 days
     *
     * can be legally significant even though
     * almost every other word is identical.
     */
    const sortedCandidates =
      candidatePairs
        .filter((pair) => {
          if (
            !pair.unitA ||
            !pair.unitB
          ) {
            return true;
          }

          return (
            normalizeForEquality(
              pair.unitA.text
            ) !==
            normalizeForEquality(
              pair.unitB.text
)
);
})
.sort((a, b) => {
          const sizeA =
            (a.unitA?.text.length ||
              0) +
            (a.unitB?.text.length ||
              0);

          const sizeB =
            (b.unitA?.text.length ||
              0) +
            (b.unitB?.text.length ||
              0);

          return sizeB - sizeA;
        })
        .slice(0, 30);

    if (
      sortedCandidates.length === 0
    ) {
      return NextResponse.json({
        documentA: {
          id: docA.id,
          name: docA.name,
        },

        documentB: {
          id: docB.id,
          name: docB.name,
        },

        comparisons: [],

        stats: {
          total: 0,
          high: 0,
          medium: 0,
          low: 0,
        },
      });
    }

    const promptContext =
      sortedCandidates
        .map((pair, index) => {
          return `[Candidate Pair ${
            index + 1
          }]
Document A Clause: ${
            pair.unitA
              ? pair.unitA.text
              : "(None)"
          }
Document B Clause: ${
            pair.unitB
              ? pair.unitB.text
              : "(None)"
          }
---`;
        })
        .join("\n");

    const prompt = `You are a legal contract expert comparing two documents.

Analyze ONLY the candidate clause pairs supplied below.

Each candidate has already been structurally matched by the application.

IMPORTANT MATCHING RULES:

- If Document A has text and Document B is "(None)", classify it as ONLY_A.
- If Document B has text and Document A is "(None)", classify it as ONLY_B.
- If both sides contain text, compare those two clauses only.
- Do not move text between candidate pairs.
- Do not invent missing clauses.
- Quotes must be copied verbatim from the supplied clauses.

Identify substantive differences, omissions, or additions.

SIGNIFICANCE:

HIGH:
Core financial or legal risk changes such as liability caps, indemnity, payment obligations, material obligations, termination rights, confidentiality/security obligations, or similarly important contractual risk.

MEDIUM:
Meaningful operational changes such as notice periods, timelines, governing law, dispute processes, procedures, or performance requirements.

LOW:
Minor wording or formatting changes with little apparent substantive effect.

Return a JSON array with EXACTLY this structure:

[
  {
    "title": "Short descriptive title",
    "quoteA": "Verbatim quote from Document A or null if ONLY_B",
    "quoteB": "Verbatim quote from Document B or null if ONLY_A",
    "summary": "Concise summary of what changed",
    "significance": "HIGH",
    "reason": "Why this change matters legally or commercially",
    "changeType": "MODIFIED"
  }
]

Allowed significance values:
"HIGH", "MEDIUM", "LOW"

Allowed changeType values:
"MODIFIED", "ONLY_A", "ONLY_B", "UNCHANGED"

If a pair is unchanged, you may omit it.

Do not return explanatory text outside the JSON array.

Candidate pairs:

${promptContext}`;

    const response =
      await gemini.models.generateContent(
        {
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            temperature: 0.1,
          },
        }
      );

    const resultText =
      response.text || "";

    const jsonMatch =
      resultText.match(
        /\[\s*[\s\S]*?\s*\]/
      );

    let rawResults: any[] = [];

    if (jsonMatch) {
      try {
        rawResults = JSON.parse(
          jsonMatch[0]
        );
      } catch (error) {
        console.error(
          "[Comparison] JSON parse error:",
          error
        );

        return NextResponse.json(
          {
            error:
              "Failed to parse model output.",
          },
          {
            status: 500,
          }
        );
      }
    } else {
      console.warn(
        "[Comparison] No JSON array found in Gemini response."
      );

      return NextResponse.json(
        {
          error:
            "Model failed to return structured results.",
        },
        {
          status: 500,
        }
      );
    }

    const verifiedComparisons: any[] =
      [];

    const stats = {
      total: 0,
      high: 0,
      medium: 0,
      low: 0,
    };

    for (const item of rawResults) {
      if (
        item.changeType ===
        "UNCHANGED"
      ) {
        continue;
      }

      if (
        ![
          "HIGH",
          "MEDIUM",
          "LOW",
        ].includes(item.significance)
      ) {
        continue;
      }

      if (
        ![
          "MODIFIED",
          "ONLY_A",
          "ONLY_B",
        ].includes(item.changeType)
      ) {
        continue;
      }

      let verifiedA:
        | {
            documentId: string;
            documentName: string;
            quote: string;
            startChar: number;
            endChar: number;
            verified: true;
          }
        | null = null;

      let verifiedB:
        | {
            documentId: string;
            documentName: string;
            quote: string;
            startChar: number;
            endChar: number;
            verified: true;
          }
        | null = null;

      /*
       * MODIFIED requires both quotations
       * to independently verify.
       */
      if (
        item.changeType ===
        "MODIFIED"
      ) {
        const offA =
          item.quoteA
            ? findQuoteOffsets(
                docA.extractedText,
                item.quoteA
)
: null;

const offB =
item.quoteB
? findQuoteOffsets(
                docB.extractedText,
                item.quoteB
)
: null;

if (offA && offB) {
          verifiedA = {
            documentId:
              docA.id,
            documentName:
              docA.name,
            quote:
              docA.extractedText.substring(
                offA.startChar,
                offA.endChar
              ),
            startChar:
              offA.startChar,
            endChar:
              offA.endChar,
            verified: true,
          };

          verifiedB = {
            documentId:
              docB.id,
            documentName:
              docB.name,
            quote:
              docB.extractedText.substring(
                offB.startChar,
                offB.endChar
              ),
            startChar:
              offB.startChar,
            endChar:
              offB.endChar,
            verified: true,
          };
        }
      }

      /*
       * ONLY_A requires a verified A quote.
       */
      else if (
        item.changeType ===
        "ONLY_A"
      ) {
        const offA =
          item.quoteA
            ? findQuoteOffsets(
                docA.extractedText,
                item.quoteA
)
: null;

if (offA) {
          verifiedA = {
            documentId:
              docA.id,
            documentName:
              docA.name,
            quote:
              docA.extractedText.substring(
                offA.startChar,
                offA.endChar
              ),
            startChar:
              offA.startChar,
            endChar:
              offA.endChar,
            verified: true,
          };
        }
      }

      /*
       * ONLY_B requires a verified B quote.
       */
      else if (
        item.changeType ===
        "ONLY_B"
      ) {
        const offB =
          item.quoteB
            ? findQuoteOffsets(
                docB.extractedText,
                item.quoteB
)
: null;

if (offB) {
          verifiedB = {
            documentId:
              docB.id,
            documentName:
              docB.name,
            quote:
              docB.extractedText.substring(
                offB.startChar,
                offB.endChar
              ),
            startChar:
              offB.startChar,
            endChar:
              offB.endChar,
            verified: true,
          };
        }
      }

      /*
       * Strict evidence rules.
       */
      const validModified =
        item.changeType ===
          "MODIFIED" &&
        verifiedA !== null &&
        verifiedB !== null;

      const validOnlyA =
        item.changeType ===
          "ONLY_A" &&
        verifiedA !== null &&
        verifiedB === null;

      const validOnlyB =
        item.changeType ===
          "ONLY_B" &&
        verifiedB !== null &&
        verifiedA === null;

      if (
        !validModified &&
        !validOnlyA &&
        !validOnlyB
      ) {
        console.warn(
          "[Comparison] Rejected unverified comparison:",
          item.title
        );

        continue;
      }

      verifiedComparisons.push({
        title:
          item.title,
        changeType:
          item.changeType,
        significance:
          item.significance,
        summary:
          item.summary,
        reason:
          item.reason,
        documentA:
          verifiedA,
        documentB:
          verifiedB,
      });

      stats.total++;

      if (
        item.significance ===
        "HIGH"
      ) {
        stats.high++;
      } else if (
        item.significance ===
        "MEDIUM"
      ) {
        stats.medium++;
      } else if (
        item.significance ===
        "LOW"
      ) {
        stats.low++;
      }
    }

    return NextResponse.json({
      documentA: {
        id: docA.id,
        name: docA.name,
      },

      documentB: {
        id: docB.id,
        name: docB.name,
      },

      comparisons:
        verifiedComparisons,

      stats,
    });
  } catch (error: any) {
    console.error(
      "[Comparison API Error]:",
      error
    );

    return NextResponse.json(
      {
        error:
          error.message ||
          "An unexpected error occurred.",
      },
      {
        status: 500,
      }
    );
  }
}