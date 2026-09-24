import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";

/**
 * GET /api/documents/[id]
 *
 * Returns one processed document together with its chunks.
 * Only allows accessing documents with PROCESSED status.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: "Document ID is required." },
        { status: 400 }
      );
    }

    const document = await prisma.document.findUnique({
      where: { id },
      include: {
        chunks: {
          orderBy: {
            chunkIndex: "asc",
          },
        },
      },
    });

    if (!document) {
      return NextResponse.json(
        { error: "Document not found." },
        { status: 404 }
      );
    }

    // Security check: only PROCESSED documents can be accessed in the workspace
    if (document.status !== "PROCESSED") {
      let message = "This document is not ready yet.";
      if (document.status === "FAILED") {
        message = `This document failed to process: ${document.errorMessage || "Unknown error"}`;
      } else if (document.status === "PROCESSING") {
        message = "This document is still being processed. Please wait.";
      }

      return NextResponse.json(
        {
          error: message,
          status: document.status,
        },
        { status: 403 }
      );
    }

    return NextResponse.json({
      id: document.id,
      name: document.name,
      originalName: document.originalName,
      mimeType: document.mimeType,
      size: document.size,
      status: document.status,
      errorMessage: document.errorMessage,
      extractedText: document.extractedText,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      chunks: document.chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        startChar: chunk.startChar,
        endChar: chunk.endChar,
      })),
    });
  } catch (error: unknown) {
    console.error("Failed to fetch document:", error);

    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while loading the document.",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/documents/[id]
 *
 * Deletes the document. Related chunks, chats, messages and
 * citations are removed through the Prisma cascade relationships.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: "Document ID is required." },
        { status: 400 }
      );
    }

    const document = await prisma.document.findUnique({
      where: { id },
    });

    if (!document) {
      return NextResponse.json(
        { error: "Document not found." },
        { status: 404 }
      );
    }

    await prisma.document.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
    });
  } catch (error: unknown) {
    console.error("Failed to delete document:", error);

    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while deleting the document.",
      },
      { status: 500 }
    );
  }
}
