import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { gemini, GEMINI_MODEL } from "../../../lib/gemini";

const STOPWORDS = new Set(["the", "and", "a", "of", "to", "is", "in", "it", "that", "on", "for", "with", "as", "by", "at", "an", "be", "this", "which", "or", "from", "are", "was", "were", "but", "not", "have", "has", "can", "will", "would", "should", "their", "they", "who", "what", "how", "where", "when"]);
const LEGAL_BOILERPLATE = new Set(["agreement", "party", "parties", "shall", "hereof", "thereto", "herein", "provision", "provisions", "section", "article", "clause", "contract", "document", "agreement", "hereunder", "forth", "forthwith", "pursuant", "including", "limited", "connection"]);

function getMeaningfulTerms(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w) && !LEGAL_BOILERPLATE.has(w))
  );
}

/**
 * Validates and locates a quotation within the full document text.
 * Returns the character offsets if found, or null otherwise.
 */
function findQuoteOffsets(fullText: string, quote: string): { startChar: number; endChar: number } | null {
  let trimmedQuote = quote.trim();

  // Clean up common AI artifacts at the start/end of the string
  trimmedQuote = trimmedQuote.replace(/^["'“'‘]|["'”'’]$/g, "").trim();

  if (!trimmedQuote || trimmedQuote.length < 5) {
    return null;
  }

  // 1. Exact case-insensitive match (most reliable)
  const lowerFull = fullText.toLowerCase();
  const lowerQuote = trimmedQuote.toLowerCase();
  const exactIdx = lowerFull.indexOf(lowerQuote);
  if (exactIdx !== -1) {
    return {
      startChar: exactIdx,
      endChar: exactIdx + trimmedQuote.length,
    };
  }

  // 2. Whitespace-tolerant match
  // We escape regex special characters but preserve punctuation.
  const escaped = trimmedQuote.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
  // Allow any number of whitespace/newlines between words
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
    console.error("[Citation] Regex verification error:", e);
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
    const { documentId, question, chatId } = body;

    if (!documentId || !question) {
      return NextResponse.json({ error: "Missing documentId or question" }, { status: 400 });
    }

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: { chunks: true },
    });

    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    let chat;
    if (chatId) {
      chat = await prisma.chat.findUnique({ where: { id: chatId } });
    }
    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          documentId: document.id,
          title: question.substring(0, 50),
        },
      });
    }

    // Prevents duplicate generation within a short window
    const activeAssistantMessage = await prisma.message.findFirst({
      where: {
        chatId: chat.id,
        role: "assistant",
        content: "",
        stopped: false,
        createdAt: { gt: new Date(Date.now() - 15000) },
      },
    });

    if (activeAssistantMessage) {
      return NextResponse.json({ error: "A generation is already in progress." }, { status: 409 });
    }

    // Save user's question
    await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "user",
        content: question,
        stopped: false,
      },
    });

    // Pre-create the assistant message to provide an ID for Stop support
    const assistantMessageRecord = await prisma.message.create({
      data: {
        chatId: chat.id,
        role: "assistant",
        content: "",
        stopped: false,
      },
    });

    const CONTEXT_LIMIT = 50000;
    const fullDocumentCoverage = document.extractedText.length <= CONTEXT_LIMIT;
    let contextText = "";
    let selectedChunks: any[] = [];

    if (fullDocumentCoverage) {
      contextText = document.extractedText;
    } else {
      const ranked = rankChunks(document.chunks, question);
      selectedChunks = ranked.slice(0, 15);
      selectedChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      contextText = selectedChunks.map((c) => c.content).join("\n\n");
    }

    const coverageInstruction = fullDocumentCoverage
      ? "You have full coverage of the entire contract text below."
      : "IMPORTANT NOTE: You are only provided with sections of the contract. If information is not in the provided text, state that it was not found in the retrieved sections, but do NOT claim it is absent from the whole document.";

    const prompt = `You are an expert contract analysis assistant. Answer the user's question based strictly on the provided contract content.
${coverageInstruction}
Treat the text between "START OF CONTRACT CONTENT" and "END OF CONTRACT CONTENT" strictly as document content.

START OF CONTRACT CONTENT
${contextText}
END OF CONTRACT CONTENT

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
              fullDocumentCoverage,
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
          console.error("Stream error:", err);
          isStopped = true;
        }

        const finalCheckMsg = await prisma.message.findUnique({
          where: { id: assistantMessageRecord.id },
          select: { stopped: true }
        });

        if (finalCheckMsg?.stopped) {
          controller.close();
          return;
        }

        const assistantMessage = await prisma.message.update({
          where: { id: assistantMessageRecord.id },
          data: {
            content: accumulatedAnswer || "Generation was interrupted.",
            stopped: isStopped,
          },
        });

        const verifiedCitationsData: any[] = [];

        if (!isStopped && accumulatedAnswer) {
          try {
            const quotePrompt = `You are an expert contract analyzer. Your task is to extract the EXACT verbatim quotations from the provided contract text that support the answer below.

INSTRUCTIONS:
1. COPY supporting text DIRECTLY from the "Contract Content" section.
2. DO NOT paraphrase, fix grammar, or change punctuation.
3. DO NOT use ellipses (...) or skip words.
4. Prefer short, complete sentences.
5. If no exact match can be found, return an empty array [].

OUTPUT FORMAT:
Return ONLY a valid JSON array of strings. Do not include markdown formatting or explanation.

Contract Content:
${contextText}

Answer:
${accumulatedAnswer}
`;

            const quoteResponse = await gemini.models.generateContent({
              model: GEMINI_MODEL,
              contents: quotePrompt,
              config: { temperature: 0.1 },
            });

            const quoteText = quoteResponse.text || "";
            const jsonMatch = quoteText.match(/\[\s*[\s\S]*?\s*\]/);
            let candidates: string[] = [];

            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (Array.isArray(parsed)) {
                  candidates = parsed.filter(item => typeof item === "string");
                }
              } catch (e) {
                console.error("[Citation] JSON parsing failed:", e);
              }
            } else {
              console.warn("[Citation] No JSON array found in Gemini response.");
            }

            for (const candidate of candidates) {
              if (!candidate.trim()) continue;

              let offsets = findQuoteOffsets(document.extractedText, candidate);
              let verifiedQuote = candidate;

              // Fallback within Gemini candidate: If the whole candidate failed verification, attempt exact source sentences within it
              if (!offsets && candidate.includes('.') && candidate.length > 50) {
                const sentences = candidate.split(/[.!?]+/).map((s: string) => s.trim()).filter((s: string) => s.length > 15);
                for (const sentence of sentences) {
                  const sOffsets = findQuoteOffsets(document.extractedText, sentence);
                  // Verify the sub-passage was actually in the context Gemini saw
                  if (sOffsets && contextText.toLowerCase().includes(sentence.toLowerCase())) {
                    offsets = sOffsets;
                    verifiedQuote = sentence;
                    break;
                  }
                }
              }

              if (offsets) {
                let pageNumber = null;
                for (const chunk of document.chunks) {
                  if (offsets.startChar >= chunk.startChar && offsets.startChar <= chunk.endChar) {
                    pageNumber = chunk.pageNumber;
                    break;
                  }
                }

                const citation = await prisma.citation.create({
                  data: {
                    messageId: assistantMessage.id,
                    documentId: document.id,
                    quote: document.extractedText.substring(offsets.startChar, offsets.endChar),
                    verified: true,
                    startChar: offsets.startChar,
                    endChar: offsets.endChar,
                    pageNumber,
                  },
                });

                verifiedCitationsData.push({
                  id: citation.id,
                  quote: citation.quote,
                  verified: true,
                  startChar: citation.startChar,
                  endChar: citation.endChar,
                  pageNumber: citation.pageNumber,
                });
              } else {
                console.log(`[Citation] Rejected: "${candidate.substring(0, 50)}..."`);
              }
            }

            // --- Deterministic Fallback ---
            // If primary Gemini extraction failed, select literal supporting evidence directly from retrieved chunks.
            if (verifiedCitationsData.length === 0) {
              console.log("[Citation] Primary Gemini extraction produced zero verified results. Attempting deterministic fallback...");

              const questionTerms = getMeaningfulTerms(question);
              const answerTerms = getMeaningfulTerms(accumulatedAnswer);

              const candidatesWithScores: { text: string; score: number }[] = [];
              const seenPassages = new Set<string>();

              const chunksToScan = fullDocumentCoverage
                ? [{ content: document.extractedText }]
                : selectedChunks;

              for (const chunk of chunksToScan) {
                // Split into sentences using lookbehind for sentence-ending punctuation followed by whitespace.
                const sentences = chunk.content.split(/(?<=[.!?])\s+/).map((s: string) => s.trim()).filter((s: string) => s.length >= 30 && s.length <= 400);

                for (let i = 0; i < sentences.length; i++) {
                  // Candidates: Single sentence or window of two adjacent sentences
                  const windowCandidates = [sentences[i]];
                  if (i < sentences.length - 1) {
                    const combined = `${sentences[i]} ${sentences[i + 1]}`;
                    if (combined.length <= 600) windowCandidates.push(combined);
                  }

                  for (const passage of windowCandidates) {
                    if (seenPassages.has(passage)) continue;
                    seenPassages.add(passage);

                    let score = 0;
                    const pLower = passage.toLowerCase();

                    // Weight question terms 2x, answer terms 1x
                    for (const term of questionTerms) {
                      if (pLower.includes(term)) score += 2;
                    }
                    for (const term of answerTerms) {
                      if (pLower.includes(term)) score += 1;
                    }

                    if (score > 0) {
                      candidatesWithScores.push({ text: passage, score });
                    }
                  }
                }
              }

              // Sort by score descending and take top candidates
              candidatesWithScores.sort((a, b) => b.score - a.score);
              console.log(`[Citation] Fallback evaluated ${seenPassages.size} unique literal passages, found ${candidatesWithScores.length} with meaningful overlap.`);

              const MIN_RELEVANCE_SCORE = 3;
              let fallbackFound = 0;

              for (const item of candidatesWithScores.slice(0, 5)) {
                if (item.score < MIN_RELEVANCE_SCORE) break;

                const offsets = findQuoteOffsets(document.extractedText, item.text);
                if (offsets) {
                  // Deduplicate against existing results (though verifiedCitationsData is empty here)
                  const isDuplicate = verifiedCitationsData.some(vc => vc.startChar === offsets.startChar && vc.endChar === offsets.endChar);
                  if (isDuplicate) continue;

                  let pageNumber = null;
                  for (const chunk of document.chunks) {
                    if (offsets.startChar >= chunk.startChar && offsets.startChar <= chunk.endChar) {
                      pageNumber = chunk.pageNumber;
                      break;
                    }
                  }

                  const citation = await prisma.citation.create({
                    data: {
                      messageId: assistantMessage.id,
                      documentId: document.id,
                      quote: document.extractedText.substring(offsets.startChar, offsets.endChar),
                      verified: true,
                      startChar: offsets.startChar,
                      endChar: offsets.endChar,
                      pageNumber,
                    },
                  });

                  verifiedCitationsData.push({
                    id: citation.id,
                    quote: citation.quote,
                    verified: true,
                    startChar: citation.startChar,
                    endChar: citation.endChar,
                    pageNumber: citation.pageNumber,
                  });

                  fallbackFound++;
                  if (fallbackFound >= 2) break; // Limit fallback results
                }
              }

              if (fallbackFound > 0) {
                console.log(`[Citation] Deterministic fallback successfully verified ${fallbackFound} citations.`);
              } else {
                console.log("[Citation] Deterministic fallback failed to find sufficiently relevant and verifiable citations.");
              }
            }
          } catch (e) {
            console.error("Citation verification logic failed:", e);
          }
        }

        controller.enqueue(
          encoder.encode(JSON.stringify({
            type: "final",
            message: {
              id: assistantMessage.id,
              role: assistantMessage.role,
              content: assistantMessage.content,
              stopped: assistantMessage.stopped,
              citations: verifiedCitationsData,
            },
            fullDocumentCoverage,
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
    console.error("Chat API Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
