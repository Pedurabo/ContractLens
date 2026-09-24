export interface Chunk {
  content: string;
  chunkIndex: number;
  startChar: number;
  endChar: number;
}

/**
 * Splits text into overlapping chunks while preserving character positions.
 * Suitable for very large documents (e.g. 150-page legal contracts).
 * @param text The full text to chunk.
 * @param chunkSize Target size of each chunk in characters.
 * @param overlap Target overlap between chunks in characters.
 */
export function chunkText(
  text: string,
  chunkSize: number = 2000,
  overlap: number = 400
): Chunk[] {
  const chunks: Chunk[] = [];
  if (!text) return chunks;

  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    if (end < text.length) {
      // Look for a newline near the end of the window to break gracefully at a paragraph/line
      const searchStart = Math.max(start, end - 200);
      const nextNewline = text.indexOf("\n", searchStart);

      if (nextNewline !== -1 && nextNewline < end + 100) {
        end = nextNewline + 1;
      } else {
        // Fallback to space break point
        const nextSpace = text.indexOf(" ", end - 40);
        if (nextSpace !== -1 && nextSpace < end + 40) {
          end = nextSpace + 1;
        }
      }
    }

    if (end > text.length) {
      end = text.length;
    }

    const content = text.substring(start, end);
    chunks.push({
      content,
      chunkIndex: index++,
      startChar: start,
      endChar: end,
    });

    if (end === text.length) break;

    const nextStart = end - overlap;

    // Safety check to ensure we always progress and avoid any potential infinite loop
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
  }

  return chunks;
}
