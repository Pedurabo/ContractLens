import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export type ExtractionResult = {
  text: string;
  pageCount?: number;
};

/**
 * Validates if the extracted text contains meaningful document content (letters or numbers).
 * Filters out documents that only contain artifacts, whitespace, or punctuation noise.
 */
function isMeaningfulText(text: string): boolean {
  if (!text) return false;
  // Check if it contains at least one alphanumeric character
  return /[a-zA-Z0-9]/.test(text);
}

export async function extractDocument(
  buffer: Buffer,
  mimeType: string
): Promise<ExtractionResult> {
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return extractDocx(buffer);
  }

  if (mimeType === "application/pdf") {
    return extractPdf(buffer);
  }

  throw new Error(
    "Unsupported file type. Only PDF and DOCX are accepted."
  );
}

/**
 * Extract text from a DOCX document.
 */
async function extractDocx(
  buffer: Buffer
): Promise<ExtractionResult> {
  try {
    const result = await mammoth.extractRawText({
      buffer,
    });

    const text = result.value.trim();

    if (!text || !isMeaningfulText(text)) {
      throw new Error(
        "No readable text was found in this DOCX document. It may be empty or contain only images."
      );
    }

    return {
      text,
    };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes("No readable text")
    ) {
      throw error;
    }

    console.error("DOCX extraction error:", error);

    throw new Error(
      "Failed to process the Word document. Please ensure it is a valid DOCX file."
    );
  }
}

/**
 * Extract text from a PDF document using pdf-parse.
 */
async function extractPdf(
  buffer: Buffer
): Promise<ExtractionResult> {
  const parser = new PDFParse({
    data: buffer,
  });

  try {
    const result = await parser.getText();
    const rawText = result.text ?? "";

    // 1. Remove artifacts that are NOT document content.
    // pdf-parse often generates artifacts like "-- 1 of 1 --" which can trick meaningful text checks.
    // We use robust regexes to remove these markers before validation and storage.
    const cleanedText = rawText
      // Match "-- 1 of 1 --" variants (handles various dash types, whitespace, and case)
      .replace(/[-—–]{1,5}\s*\d+\s*of\s*\d+\s*[-—–]{1,5}/gi, " ")
      // Match "Page 1 of 5" or "Page 1" lines
      .replace(/Page\s*\d+\s*(of\s*\d+)?/gi, " ")
      // Match lines that are just numbers (often page footers or headers)
      .replace(/^\s*\d+\s*$/gm, " ")
      .trim();

    // 2. Normalize whitespace
    const text = cleanedText
      .replace(/[ \t]+/g, " ")     // Normalize horizontal whitespace
      .replace(/\n\s*\n/g, "\n\n") // Normalize multiple newlines
      .trim();

    // 3. Verify if meaningful document content remains after artifact removal
    if (!text || !isMeaningfulText(text)) {
      throw new Error(
        "No readable text was found in this PDF. It may be a scanned or image-only document."
      );
    }

    return {
      text,
      pageCount: result.total,
    };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes("No readable text")
    ) {
      throw error;
    }

    console.error("PDF extraction error:", error);

    throw new Error(
      "Failed to parse the PDF document. Please ensure it is a valid, uncorrupted PDF contract."
    );
  } finally {
    // Ensure parser cleanup if supported by the project's PDFParse implementation
    if (parser && typeof (parser as any).destroy === 'function') {
      await (parser as any).destroy();
    }
  }
}
