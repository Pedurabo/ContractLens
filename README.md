# ContractLens

ContractLens is an AI-powered legal contract analysis web application built for the engineering assignment.

It allows users to upload PDF and DOCX contracts, ask grounded questions about their contents, receive streaming AI answers backed by independently verified quotations, compare multiple documents, inspect clause-level differences, and perform multi-round agentic document research.

## Core Principle

ContractLens does not trust an AI model's citation claims by default.

When Gemini returns a quotation, the application independently searches the original extracted document text for that quotation. Only quotations that can be matched back to the source document are displayed as verified citations.

This provides a stronger grounding layer than simply asking the model to provide page numbers, offsets, or citations.

---

## Features

### Document Upload and Processing

- Upload PDF and DOCX files.
- Reject unsupported file types.
- Extract text from uploaded documents.
- Store documents and chunks locally using SQLite and Prisma.
- Track PROCESSING, PROCESSED, and FAILED states.
- Detect PDFs with no meaningful readable text, including image-only/scanned PDFs.
- View uploaded documents in a document library.
- Delete documents and their associated data.

### Grounded Contract Q&A

Users can open a processed contract and ask questions about it.

ContractLens provides:

- Streaming Gemini responses.
- Stop-generation support.
- Persistence of partial stopped responses.
- Saved chat history per document.
- Retrieval of relevant contract chunks.
- Exact supporting quotations.
- Independent citation verification.
- Clickable citations that navigate back to the source passage.
- Highlighting of the cited source text.

If the requested information cannot be supported by the document, the system is designed to avoid inventing an answer.

### Large Document Support

Large contracts are split into overlapping text chunks.

Each chunk stores:

- Chunk index.
- Original character start offset.
- Original character end offset.
- Extracted content.

For documents that exceed the context budget, ContractLens retrieves relevant chunks rather than sending the entire document to Gemini.

Citation verification is still performed against the full original extracted document text.

This was tested with a synthetic 150-page contract containing a unique clause near page 145.

### Verified Citation Navigation

Verified citations store source character offsets.

Clicking **Open in document** navigates to the corresponding document and passes the verified start and end offsets.

The document viewer then:

1. Locates the verified character range.
2. Highlights the cited text.
3. Automatically scrolls to the passage.

The application does not rely on model-generated page numbers or offsets.

---

## Multi-Document Q&A

ContractLens supports asking one question across multiple selected documents.

The multi-document workflow:

1. Retrieves evidence independently from each selected document.
2. Provides the evidence to Gemini for comparative reasoning.
3. Associates candidate quotations with their source document.
4. Independently verifies each quotation against that specific document.
5. Displays verified evidence grouped by source.
6. Allows citations to open the correct document and highlighted passage.

This enables questions such as:

> How do the payment and termination provisions differ between these contracts?

---

## Document Comparison

The comparison feature performs clause/paragraph-level comparison between two processed contracts.

It identifies changes such as:

- Modified clauses.
- Clauses appearing only in document A.
- Clauses appearing only in document B.
- Material numerical changes.
- Changes in obligations, deadlines, governing law, liability, and other contract terms.

Comparison results include:

- Change type.
- Significance level.
- AI-generated explanation of the substantive difference.
- Independently verified evidence from each document.
- Links back to the original passages.

The UI supports filtering comparison results by change type and significance.

---

## Agentic Document Research

ContractLens includes an agentic research workflow as the advanced feature.

The research agent has three document exploration tools:

### `list_clauses`

Inspects the document structure and identifies likely clause headings.

### `search_document`

Searches stored document chunks for passages relevant to a query.

### `get_section`

Retrieves a larger surrounding section when additional context is required.

### Multi-Round Agent Loop

The agent operates in a real multi-round loop.

For each round:

1. Gemini receives the research question and results from previous rounds.
2. Gemini decides whether to call another document tool or produce the final answer.
3. The server validates the requested tool call.
4. The selected tool executes.
5. The tool result is returned to Gemini.
6. The process repeats until the agent finishes or reaches the hard round limit.

The agent has a maximum budget of six rounds.

The UI displays live research activity so the user can see which tools the agent is using.

Malformed tool responses and duplicate tool calls are handled by the server rather than blindly executed.

Final quotations are independently verified against the original extracted document text before being displayed.

---

## Citation Verification

Citation integrity is one of the main design goals of ContractLens.

The verification pipeline attempts:

1. Exact text matching.
2. Case-insensitive matching.
3. Whitespace-normalized matching while retaining a mapping back to original character offsets.

A quotation is displayed as verified only when the server can locate it in the extracted source document.

Unverified model-generated quotations are rejected.

This means Gemini is responsible for reasoning, while the application itself is responsible for determining whether cited evidence genuinely exists in the uploaded contract.

---

## Technology Stack

- Next.js 16
- React
- TypeScript
- Tailwind CSS
- Gemini API via `@google/genai`
- Prisma 7
- SQLite
- `pdf-parse`
- `mammoth`
- `react-markdown`

---

## Project Structure

```text
app/
  api/
    chat/
      route.ts
      multi/
      stop/
    compare/
      route.ts
    documents/
    research/
      route.ts

  chat/
    multi/

  compare/

  documents/
    [id]/

  research/

lib/
  chunking.ts
  extract.ts
  gemini.ts
  prisma.ts

prisma/
  schema.prisma
  migrations/

src/
  generated/
    prisma/