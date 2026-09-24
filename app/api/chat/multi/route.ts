import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { gemini, GEMINI_MODEL } from "../../../../lib/gemini";

const STOPWORDS = new Set(["the", "and", "a", "of", "to", "is", "in", "it", "that", "on", "for", "with", "as", "by", "at", "an", "be", "this", "which", "or", "from", "are", "was", "were", "but", "not", "have", "has", "can", "will", "would", "should", "their", "they", "who", "what", "how", "where", "when"]);
const LEGAL_BOILERPLATE = new Set(["agreement", "party", "parties", "shall", "hereof", "thereto", "herein", "provision", "provisions", "section", "article", "clause", "contract", "document", "agreement", "hereunder", "forth", "forthwith", "pursuant", "including", "limited", "connection"]);

function getMeaningfulTerms(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w) && !LEGAL_BOILERPLATE.has(w))
  );
}

function findQuoteOffsets(fullText: string, quote: string): { startChar: number; endChar: number } | null {
  let trimmedQuote = quote.trim();
  trimmedQuote = trimmedQuote.replace(/^["'“'‘]|["'”'’]$/g, "").trim();

  if (!trimmedQuote || trimmedQuote.length < 5) {
    return null;
  }

  const lowerFull = fullText.toLowerCase();
  const lowerQuote = trimmedQuote.toLowerCase();
  const exactIdx = lowerFull.indexOf(lowerQuote);
  if (exactIdx !== -1) {
    return {
      startChar: exactIdx,
      endChar: exactIdx + trimmedQuote.length,
    };
  }

  const escaped = trimmedQuote.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
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
  } catch (e) {
    console.error("[Multi-Citation] Regex verification error:", e);
  }

  return null;
}

function rankChunks(chunks: any[], question: string): any[] {
  const words = question.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (words.length === 0) return chunks;

  return chunks
    .map((chunk) => {
      let score = 0;
      const contentLower = chunk.content.toLowerCase();
      for (const word of words) {
        if (contentLower.includes(word)) {
          score += 1;
        }
      }
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.chunk);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { documentIds, question } = body;

    if (!question || typeof question !== "string" || !question.trim()) {
      return NextResponse.json({ error: "Missing or invalid question string." }, { status: 400 });
    }

    if (!documentIds || !Array.isArray(documentIds)) {
      return NextResponse.json({ error: "documentIds must be an array." }, { status: 400 });
    }

    const uniqueIds = Array.from(new Set(documentIds)).filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    if (uniqueIds.length < 2) {
      return NextResponse.json({ error: "At least 2 unique document IDs are required." }, { status: 400 });
    }

    // Fetch all requested documents
    const documents = await prisma.document.findMany({
      where: { id: { in: uniqueIds } },
      include: { chunks: true },
    });

    if (documents.length !== uniqueIds.length) {
      return NextResponse.json({ error: "One or more requested documents could not be found." }, { status: 404 });
    }

    // Every requested document must have status === "PROCESSED"
    for (const doc of documents) {
      if (doc.status !== "PROCESSED") {
        return NextResponse.json({ error: `Document '${doc.name}' is not processed (Current status: ${doc.status}).` }, { status: 400 });
      }
    }

    // Anchor Chat to the first selected document
    const primaryDoc = documents[0];
    const chat = await prisma.chat.create({
      data: {
        documentId: primaryDoc.id,
        title: `Multi-Doc Analysis: ${question.substring(0, 40)}`,
      },
    });

    // Create user message
    await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "user",
        content: question,
        stopped: false,
      },
    });

    // Pre-create assistant message
    const assistantMessageRecord = await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "assistant",
        content: "",
        stopped: false,
      },
    });

    const CONTEXT_LIMIT = 50000;
    const documentCoverage: { documentId: string; documentName: string; fullDocumentCoverage: boolean }[] = [];

    // Per-document retrieval and prompt section construction
    let promptSourcesText = "";
    const docContextMap = new Map<string, { contextText: string; selectedChunks: any[]; fullCoverage: boolean }>();

    for (let idx = 0; idx < documents.length; idx++) {
      const doc = documents[idx];
      const fullCoverage = doc.extractedText.length <= CONTEXT_LIMIT;
      documentCoverage.push({
        documentId: doc.id,
        documentName: doc.name,
        fullDocumentCoverage: fullCoverage,
      });

      let docContextText = "";
      let docSelectedChunks: any[] = [];

      if (fullCoverage) {
        docContextText = doc.extractedText;
      } else {
        const ranked = rankChunks(doc.chunks, question);
        docSelectedChunks = ranked.slice(0, 15);
        docSelectedChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        docContextText = docSelectedChunks.map((c) => c.content).join("\n\n");
      }

      docContextMap.set(doc.id, {
        contextText: docContextText,
        selectedChunks: docSelectedChunks,
        fullCoverage,
      });

      const label = String.fromCharCode(65 + idx); // A, B, C...
      promptSourcesText += `=== DOCUMENT ${label} ===\n`;
      promptSourcesText += `DOCUMENT_ID: ${doc.id}\n`;
      promptSourcesText += `DOCUMENT_NAME: ${doc.name}\n`;
      promptSourcesText += `COVERAGE: ${fullCoverage ? "FULL DOCUMENT" : "RETRIEVED SECTIONS ONLY"}\n`;
      promptSourcesText += `CONTENT:\n${docContextText}\n\n`;
    }

    const prompt = `You are an expert contract analysis assistant. Answer the user's question by performing a cross-document analysis strictly based on the provided contract materials below.

${promptSourcesText}

INSTRUCTIONS:
1. Answer only from the supplied contract material. Do not invent any outside facts.
2. Distinguish documents explicitly by name when presenting claims or comparison points.
3. Attribute comparisons to the correct document using its exact name.
4. Never claim a document lacks a provision unless its COVERAGE is "FULL DOCUMENT".
5. For documents with "RETRIEVED SECTIONS ONLY" coverage, if a clause is not found, state exactly: "Not found in the retrieved sections of [document name]". Do not state that the document does not contain it.
6. Do not invent evidence or guess data.

User Question: ${question}
`;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let accumulatedAnswer = "";
        let isStopped = false;

        try {
          const models = Array.from(new Set([
            GEMINI_MODEL,
            "gemini-3.5-flash-lite",
            "gemini-2.5-flash-lite",
          ]));
          let responseStream: any = null;
          let lastError: unknown = null;

          for (const model of models) {
            try {
              responseStream = await gemini.models.generateContentStream({
                model,
                contents: prompt,
                config: { temperature: 0.1 },
              });
              break;
            } catch (error: any) {
              lastError = error;
              const status = Number(error?.status || error?.code || 0);
              if (![429, 500, 502, 503, 504].includes(status)) throw error;
              console.warn(`[Multi-Chat] ${model} unavailable (${status}); trying fallback.`);
            }
          }

          if (!responseStream) throw lastError || new Error("No Gemini model available.");

          controller.enqueue(
            encoder.encode(JSON.stringify({
              type: "status",
              documentCoverage,
              chatId: chat.id,
              messageId: assistantMessageRecord.id,
            }) + "\n")
          );

          for await (const chunk of responseStream) {
            const checkMsg = await prisma.message.findUnique({
              where: { id: assistantMessageRecord.id },
              select: { stopped: true }
            });
            if (checkMsg?.stopped) {
              isStopped = true;
              break;
            }

            const text = chunk.text || "";
            accumulatedAnswer += text;
            controller.enqueue(encoder.encode(JSON.stringify({ type: "content", text }) + "\n"));
          }
        } catch (err) {
          console.error("Multi-document stream error:", err);
          isStopped = true;
        }

        if (isStopped) {
          controller.close();
          return;
        }

        const assistantMessage = await prisma.message.update({
          where: { id: assistantMessageRecord.id },
          data: {
            content: accumulatedAnswer || "Cross-document analysis was interrupted.",
            stopped: isStopped,
          },
        });

        const verifiedCitationsData: any[] = [];

        if (accumulatedAnswer) {
          const questionTerms = getMeaningfulTerms(question);
          const answerTerms = getMeaningfulTerms(accumulatedAnswer);

          for (const doc of documents) {
            const docContext = docContextMap.get(doc.id);
            if (!docContext) continue;

            const source = docContext.fullCoverage
              ? doc.extractedText
              : docContext.selectedChunks.map((chunk) => chunk.content).join("\n\n");

            const passages = source
              .split(/(?<=[.!?])\s+|\n+/)
              .map((passage) => passage.trim())
              .filter((passage) => passage.length >= 20 && passage.length <= 700)
              .map((passage) => {
                const lower = passage.toLowerCase();
                let questionScore = 0;
                let score = 0;
                for (const term of questionTerms) {
                  if (lower.includes(term)) {
                    questionScore += 1;
                    score += 3;
                  }
                }
                for (const term of answerTerms) {
                  if (lower.includes(term)) score += 1;
                }
                return { passage, questionScore, score };
              })
              .filter((item) => item.questionScore > 0 && item.score >= 4)
              .sort((a, b) => b.score - a.score);

            for (const item of passages.slice(0, 10)) {
              const offsets = findQuoteOffsets(doc.extractedText, item.passage);
              if (!offsets) continue;

              const duplicate = verifiedCitationsData.some(
                (citation) =>
                  citation.documentId === doc.id &&
                  citation.startChar === offsets.startChar &&
                  citation.endChar === offsets.endChar
              );
              if (duplicate) continue;

              const citation = await prisma.citation.create({
                data: {
                  messageId: assistantMessage.id,
                  documentId: doc.id,
                  quote: doc.extractedText.substring(offsets.startChar, offsets.endChar),
                  verified: true,
                  startChar: offsets.startChar,
                  endChar: offsets.endChar,
                  pageNumber: null,
                },
              });

              verifiedCitationsData.push({
                id: citation.id,
                documentId: doc.id,
                documentName: doc.name,
                quote: citation.quote,
                verified: true,
                startChar: citation.startChar,
                endChar: citation.endChar,
              });
              break;
            }
          }

          console.log(`[Multi-Citation] Local verifier produced ${verifiedCitationsData.length} verified citation(s).`);
        }

        controller.enqueue(
          encoder.encode(JSON.stringify({
            type: "final",
            messageId: assistantMessage.id,
            citations: verifiedCitationsData,
            documentCoverage,
          }) + "\n")
        );
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error: unknown) {
    console.error("Multi-Chat API Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
