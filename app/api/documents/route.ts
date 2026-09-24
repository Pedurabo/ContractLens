import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { extractDocument } from "../../../lib/extract";
import { chunkText } from "../../../lib/chunking";

export async function GET() {
  try {
    const documents = await prisma.document.findMany({
      select: {
        id: true,
        name: true,
        originalName: true,
        mimeType: true,
        size: true,
        status: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(documents);
  } catch (error: unknown) {
    console.error("Failed to fetch documents:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let createdDocumentId: string | null = null;

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "No file was provided in the upload request." },
        { status: 400 }
      );
    }

    if (file.size === 0) {
      return NextResponse.json(
        { error: "The provided file is empty." },
        { status: 400 }
      );
    }

    const allowedMimeTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (!allowedMimeTypes.includes(file.type)) {
      return NextResponse.json(
        { error: "Unsupported file type. Only PDF and DOCX documents are accepted." },
        { status: 400 }
      );
    }

    // 1. Create document record immediately with PROCESSING status
    const createdDocument = await prisma.document.create({
      data: {
        name: file.name,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        extractedText: "",
        status: "PROCESSING",
      },
    });
    createdDocumentId = createdDocument.id;

    // Convert file to buffer for extraction utility
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let extraction;
    try {
      extraction = await extractDocument(buffer, file.type);
    } catch (extractError: unknown) {
      const message = extractError instanceof Error ? extractError.message : "Extraction failed";

      // Update status to FAILED
      await prisma.document.update({
        where: { id: createdDocumentId },
        data: {
          status: "FAILED",
          errorMessage: message,
        },
      });

      return NextResponse.json(
        {
          id: createdDocumentId,
          name: file.name,
          status: "FAILED",
          error: message,
        },
        { status: 200 } // Returning 200 because the record exists and is in FAILED state
      );
    }

    if (!extraction || !extraction.text || !extraction.text.trim()) {
      const errorMsg = "No readable text was found in this document. It may be a scanned document or image.";

      await prisma.document.update({
        where: { id: createdDocumentId },
        data: {
          status: "FAILED",
          errorMessage: errorMsg,
        },
      });

      return NextResponse.json(
        {
          id: createdDocumentId,
          name: file.name,
          status: "FAILED",
          error: errorMsg,
        },
        { status: 200 }
      );
    }

    const chunks = chunkText(extraction.text);

    // 2. Finalize processing: Update status to PROCESSED and create chunks
    await prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: createdDocumentId! },
        data: {
          extractedText: extraction.text,
          status: "PROCESSED",
        },
      });

      if (chunks.length > 0) {
        await tx.documentChunk.createMany({
          data: chunks.map((c) => ({
            documentId: createdDocumentId!,
            content: c.content,
            chunkIndex: c.chunkIndex,
            startChar: c.startChar,
            endChar: c.endChar,
            pageNumber: extraction.pageCount ? 1 : null,
          })),
        });
      }
    });

    return NextResponse.json(
      {
        id: createdDocumentId,
        name: file.name,
        status: "PROCESSED",
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error("Failed to process document upload:", error);

    if (createdDocumentId) {
      const message = error instanceof Error ? error.message : "An unexpected error occurred.";
      await prisma.document.update({
        where: { id: createdDocumentId },
        data: {
          status: "FAILED",
          errorMessage: message,
        },
      }).catch(err => console.error("Failed to set document to FAILED:", err));
    }

    return NextResponse.json(
      { error: "An unexpected error occurred during document processing." },
      { status: 500 }
    );
  }
}
