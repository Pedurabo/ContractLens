import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../../lib/prisma";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const document = await prisma.document.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!document) {
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 }
      );
    }

    const chat = await prisma.chat.findFirst({
      where: { documentId: id },
      orderBy: { updatedAt: "desc" },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            citations: {
              where: { verified: true },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    if (!chat) {
      return NextResponse.json({
        chatId: null,
        messages: [],
      });
    }

    return NextResponse.json({
      chatId: chat.id,
      messages: chat.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        stopped: m.stopped,
        createdAt: m.createdAt,
        citations: m.citations.map((c) => ({
          id: c.id,
          quote: c.quote,
          verified: c.verified,
          startChar: c.startChar,
          endChar: c.endChar,
          pageNumber: c.pageNumber,
        })),
      })),
    });
  } catch (error: unknown) {
    console.error("Chat history load error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
