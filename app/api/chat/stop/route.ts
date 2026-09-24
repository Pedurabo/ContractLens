import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messageId, content } = body;

    if (!messageId) {
      return NextResponse.json({ error: "Missing messageId" }, { status: 400 });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message || message.role !== "assistant") {
      return NextResponse.json({ error: "Message not found or invalid" }, { status: 404 });
    }

    // Securely update the assistant message to be marked as stopped with the client's current accumulated text
    const updatedMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: typeof content === "string" ? content : message.content,
        stopped: true,
      },
    });

    return NextResponse.json({ success: true, messageId: updatedMessage.id });
  } catch (error: unknown) {
    console.error("Error in stop endpoint:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
