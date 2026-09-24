import mammoth from "mammoth";

export type ExtractionResult = {
  text: string;
  pageCount?: number;
};

function isMeaningfulText(text: string): boolean {
  if (!text) return false;
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

async function extractPdf(
  buffer: Buffer
): Promise<ExtractionResult> {
  let parser: any = null;

  try {
    // pdfjs-dist expects browser graphics globals such as DOMMatrix.
    // On Node/Vercel, @napi-rs/canvas provides compatible implementations.
    const canvas = await import("@napi-rs/canvas");

    if (typeof globalThis.DOMMatrix === "undefined") {
      (globalThis as any).DOMMatrix = canvas.DOMMatrix;
    }

    if (typeof globalThis.ImageData === "undefined") {
      (globalThis as any).ImageData = canvas.ImageData;
    }

    if (typeof globalThis.Path2D === "undefined") {
      (globalThis as any).Path2D = canvas.Path2D;
    }

    // Import pdf-parse only AFTER the required globals exist.
    const { PDFParse } = await import("pdf-parse");

    parser = new PDFParse({
      data: buffer,
    });

    const result = await parser.getText();
    const rawText = result.text ?? "";

    const cleanedText = rawText
      .replace(/[-—–]{1,5}\s*\d+\s*of\s*\d+\s*[-—–]{1,5}/gi, " ")
      .replace(/Page\s*\d+\s*(of\s*\d+)?/gi, " ")
      .replace(/^\s*\d+\s*$/gm, " ")
      .trim();

    const text = cleanedText
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n/g, "\n\n")
      .trim();

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
    if (
      parser &&
      typeof parser.destroy === "function"
    ) {
      await parser.destroy();
    }
  }
}
