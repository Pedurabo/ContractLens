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
        let activeModel = GEMINI_MODEL;

        try {
          let responseStream;
          const MAX_STREAM_ATTEMPTS = 1;
          const fallbackModels = [
            "gemini-3.8-flash",
            "gemini-3.7-flash",
            "gemini-3.6-flash",
            "gemini-3.5-flash",
          ].filter((model) => model !== GEMINI_MODEL);
          const modelsToTry = [GEMINI_MODEL, ...fallbackModels];
          let lastStreamError: unknown = null;

          modelLoop:
          for (const model of modelsToTry) {
            for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt++) {
              try {
                responseStream = await gemini.models.generateContentStream({
                  model,
                  contents: prompt,
                  config: { temperature: 0.1 },
                });
                activeModel = model;
                if (model !== GEMINI_MODEL) {
                  console.warn(`[Chat] Primary model unavailable. Using fallback model ${model}.`);
                }
                break modelLoop;
              } catch (error: any) {
                lastStreamError = error;
                const status = error?.status ?? error?.error?.code;
                const retryable =
                  status === 429 ||
                  status === 500 ||
                  status === 502 ||
                  status === 503 ||
                  status === 504;

                if (!retryable) {
                  console.warn(
                    `[Chat] Model ${model} failed with non-retryable status ${status}. Trying next fallback model.`
                  );
                  break;
                }

                console.warn(
                  `[Chat] Model ${model} unavailable with status ${status}. Trying next fallback model immediately.`
                );
              }
            }
          }

          if (!responseStream) {
            throw lastStreamError ?? new Error("No Gemini model could start the stream.");
          }

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

        // Citation verification is deliberately local and deterministic.
        // We never depend on a second AI request to decide whether evidence is genuine.
        if (!isStopped && accumulatedAnswer) {
          const questionTerms = getMeaningfulTerms(question);
          const answerTerms = getMeaningfulTerms(accumulatedAnswer);
          const sourceText = fullDocumentCoverage
            ? document.extractedText
            : selectedChunks.map((chunk) => chunk.content).join("\n\n");

          const rawPassages = sourceText
            .split(/(?<=[.!?])\s+|\n+/)
            .map((passage: string) => passage.trim())
            .filter((passage: string) => passage.length >= 20 && passage.length <= 700);

          const rankedPassages = rawPassages
            .map((passage: string) => {
              const lower = passage.toLowerCase();
              let questionScore = 0;
              let answerScore = 0;

              for (const term of questionTerms) {
                if (lower.includes(term)) questionScore += 3;
              }
              for (const term of answerTerms) {
                if (lower.includes(term)) answerScore += 1;
              }

              return {
                passage,
                score: questionScore + answerScore,
                questionScore,
              };
            })
            .filter((item) => item.questionScore > 0 && item.score >= 4)
            .sort((a, b) => b.score - a.score);

          for (const item of rankedPassages.slice(0, 10)) {
            const offsets = findQuoteOffsets(document.extractedText, item.passage);
            if (!offsets) continue;

            const duplicate = verifiedCitationsData.some(
              (citation) =>
                citation.startChar === offsets.startChar &&
                citation.endChar === offsets.endChar
            );
            if (duplicate) continue;

            let pageNumber = null;
            for (const chunk of document.chunks) {
              if (
                offsets.startChar >= chunk.startChar &&
                offsets.startChar <= chunk.endChar
              ) {
                pageNumber = chunk.pageNumber;
                break;
              }
            }

            const citation = await prisma.citation.create({
              data: {
                messageId: assistantMessage.id,
                documentId: document.id,
                quote: document.extractedText.substring(
                  offsets.startChar,
                  offsets.endChar
                ),
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

            if (verifiedCitationsData.length >= 3) break;
          }

          console.log(
            `[Citation] Local verifier produced ${verifiedCitationsData.length} verified citation(s).`
          );
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
