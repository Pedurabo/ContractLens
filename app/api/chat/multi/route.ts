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
          const responseStream = await gemini.models.generateContentStream({
            model: GEMINI_MODEL,
            contents: prompt,
            config: { temperature: 0.1 },
          });

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
          try {
            const quotePrompt = `You are an expert contract analyzer. Your task is to extract the EXACT verbatim quotations from the provided contracts that support the answer below.

INSTRUCTIONS:
1. COPY supporting text DIRECTLY from the document contents provided.
2. DO NOT paraphrase, fix grammar, or alter punctuation.
3. DO NOT use ellipses (...) or skip words.
4. For each citation, specify the EXACT corresponding documentId and the literal quotation text.
5. If no exact match can be found, return an empty array [].

OUTPUT FORMAT:
Return ONLY a valid JSON array of objects. Do not include markdown formatting or explanation. Each object must have "documentId" and "quote" properties.

Example format:
[
  { "documentId": "some-id-123", "quote": "verbatim text here" }
]

Contracts Content:
${promptSourcesText}

Answer to support:
${accumulatedAnswer}
`;

            const quoteResponse = await gemini.models.generateContent({
              model: GEMINI_MODEL,
              contents: quotePrompt,
              config: { temperature: 0.1 },
            });

            const quoteText = quoteResponse.text || "";
            const jsonMatch = quoteText.match(/\[\s*[\s\S]*?\s*\]/);
            let candidates: { documentId: string; quote: string }[] = [];

            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed)) {
                  candidates = parsed.filter((item: any) => item && typeof item === "object" && typeof item.documentId === "string" && typeof item.quote === "string");
                }
              } catch (e) {
                console.error("[Multi-Citation] JSON parsing failed:", e);
              }
            }

            const uniqueRequestedIds = new Set(uniqueIds);

            for (const candidate of candidates) {
              if (!candidate.quote.trim()) continue;
              if (!uniqueRequestedIds.has(candidate.documentId)) {
                console.log(`[Multi-Citation] Rejected due to invalid documentId reference: ${candidate.documentId}`);
                continue;
              }

              const targetDoc = documents.find(d => d.id === candidate.documentId);
              if (!targetDoc) continue;

              let offsets = findQuoteOffsets(targetDoc.extractedText, candidate.quote);

              if (offsets) {
                const isDuplicate = verifiedCitationsData.some(vc => vc.documentId === candidate.documentId && vc.startChar === offsets!.startChar && vc.endChar === offsets!.endChar);
                if (isDuplicate) continue;

                let pageNumber = null;
                for (const chunk of targetDoc.chunks) {
                  if (offsets.startChar >= chunk.startChar && offsets.startChar <= chunk.endChar) {
                    pageNumber = chunk.pageNumber;
                    break;
                  }
                }

                const citation = await prisma.citation.create({
                  data: {
                    messageId: assistantMessage.id,
                    documentId: targetDoc.id,
                    quote: targetDoc.extractedText.substring(offsets.startChar, offsets.endChar),
                    verified: true,
                    startChar: offsets.startChar,
                    endChar: offsets.endChar,
                    pageNumber,
                  },
                });

                verifiedCitationsData.push({
                  id: citation.id,
                  documentId: targetDoc.id,
                  documentName: targetDoc.name,
                  quote: citation.quote,
                  verified: true,
                  startChar: citation.startChar,
                  endChar: citation.endChar,
                });
              } else {
                console.log(`[Multi-Citation] Rejected verbatim match for document ${targetDoc.name}: "${candidate.quote.substring(0, 50)}..."`);
              }
            }

            // --- Deterministic Fallback ---
            // If primary citation extraction produced zero verified entries, fallback programmatically
            if (verifiedCitationsData.length === 0) {
              console.log("[Multi-Citation] Primary Gemini extraction produced zero verified results. Attempting cross-document deterministic fallback...");

              const questionTerms = getMeaningfulTerms(question);
              const answerTerms = getMeaningfulTerms(accumulatedAnswer);

              const candidatesWithScores: { text: string; score: number; documentId: string; documentName: string; targetDoc: any }[] = [];
              const seenPassages = new Set<string>();

              for (const doc of documents) {
                const docContext = docContextMap.get(doc.id);
                if (!docContext) continue;

                const chunksToScan = docContext.fullCoverage
                  ? [{ content: doc.extractedText }]
                  : docContext.selectedChunks;

                for (const chunk of chunksToScan) {
                  const sentences = chunk.content.split(/(?<=[.!?])\s+/).map((s: string) => s.trim()).filter((s: string) => s.length >= 30 && s.length <= 400);

                  for (let i = 0; i < sentences.length; i++) {
                    const windowCandidates = [sentences[i]];
                    if (i < sentences.length - 1) {
                      const combined = `${sentences[i]} ${sentences[i + 1]}`;
                      if (combined.length <= 600) windowCandidates.push(combined);
                    }

                    for (const passage of windowCandidates) {
                      const dedupeKey = `${doc.id}::${passage}`;
                      if (seenPassages.has(dedupeKey)) continue;
                      seenPassages.add(dedupeKey);

                      let score = 0;
                      const pLower = passage.toLowerCase();

                      for (const term of questionTerms) {
                        if (pLower.includes(term)) score += 2;
                      }
                      for (const term of answerTerms) {
                        if (pLower.includes(term)) score += 1;
                      }

                      if (score > 0) {
                        candidatesWithScores.push({
                          text: passage,
                          score,
                          documentId: doc.id,
                          documentName: doc.name,
                          targetDoc: doc,
                        });
                      }
                    }
                  }
                }
              }

              candidatesWithScores.sort((a, b) => b.score - a.score);
              console.log(`[Multi-Citation] Fallback evaluated ${seenPassages.size} unique literal passages across contracts, found ${candidatesWithScores.length} with overlap.`);

              const MIN_RELEVANCE_SCORE = 3;
              let fallbackFound = 0;

              for (const item of candidatesWithScores.slice(0, 6)) {
                if (item.score < MIN_RELEVANCE_SCORE) break;

                const offsets = findQuoteOffsets(item.targetDoc.extractedText, item.text);
                if (offsets) {
                  const isDuplicate = verifiedCitationsData.some(vc => vc.documentId === item.documentId && vc.startChar === offsets!.startChar && vc.endChar === offsets!.endChar);
                  if (isDuplicate) continue;

                  let pageNumber = null;
                  for (const chunk of item.targetDoc.chunks) {
                    if (offsets.startChar >= chunk.startChar && offsets.startChar <= chunk.endChar) {
                      pageNumber = chunk.pageNumber;
                      break;
                    }
                  }

                  const citation = await prisma.citation.create({
                    data: {
                      messageId: assistantMessage.id,
                      documentId: item.documentId,
                      quote: item.targetDoc.extractedText.substring(offsets.startChar, offsets.endChar),
                      verified: true,
                      startChar: offsets.startChar,
                      endChar: offsets.endChar,
                      pageNumber,
                    },
                  });

                  verifiedCitationsData.push({
                    id: citation.id,
                    documentId: item.documentId,
                    documentName: item.documentName,
                    quote: citation.quote,
                    verified: true,
                    startChar: citation.startChar,
                    endChar: citation.endChar,
                  });

                  fallbackFound++;
                  if (fallbackFound >= 3) break; // Allow up to 3 valid fallback citations across docs
                }
              }

              if (fallbackFound > 0) {
                console.log(`[Citation] Deterministic fallback successfully verified ${fallbackFound} citations.`);
              } else {
                console.log("[Citation] Deterministic fallback found no sufficiently relevant verifiable cross-document citations.");
              }
            }
          } catch (e) {
            console.error("Multi-document citation extraction/fallback failed:", e);
          }
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
