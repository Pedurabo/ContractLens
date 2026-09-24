# ContractLens

ContractLens is a production-ready AI contract analysis platform focused on grounded answers, independently verified evidence, multi-document reasoning, clause-level comparison, and agentic document research.

It allows users to upload PDF and DOCX contracts, ask grounded questions about their contents, receive streaming AI answers backed by independently verified quotations, compare multiple documents, inspect clause-level differences, and perform multi-round research workflows.

## Portfolio Highlights

- Production deployment on Vercel
- PDF and DOCX ingestion with processing states
- Large-document chunking and retrieval
- Streaming contract Q&A with saved history
- Independently verified citations with source highlighting
- Multi-document comparative Q&A
- Clause/paragraph-level document comparison
- Agentic research with bounded tool-use rounds
- PostgreSQL persistence with Prisma
- Graceful provider-failure fallbacks

## Live Demo

Vercel profile: https://vercel.com/perdurabo

The production deployment is hosted on Vercel. If you are reviewing this project for a role, the fastest way to evaluate it is to open the ContractLens project from my Vercel profile, try a processed contract, ask a question, inspect a verified citation, and open the highlighted source passage.


## Core Principle

ContractLens does not trust an AI model's citation claims by default.

The application independently searches the original extracted document text for every candidate quotation. Single- and multi-document Q&A use deterministic local evidence selection after answer generation, while comparison and research outputs are also independently checked before display. Only quotations that can be matched back to the source document are displayed as verified citations.

This provides a stronger grounding layer than simply asking the model to provide page numbers, offsets, or citations.

---

## Features

### Document Upload and Processing

- Upload PDF and DOCX files.
- Reject unsupported file types.
- Extract text from uploaded documents.
- Store documents, chunks, chats, and citations in PostgreSQL using Prisma.
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

The UI displays live research activity so the user can see which tools the agent is using. If Gemini becomes temporarily unavailable during research, the server can fall back to local document search over stored chunks and still return independently verified evidence rather than hanging indefinitely.

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

This separates model reasoning from evidence integrity: the application itself determines whether cited evidence genuinely exists in the uploaded contract.

---

## Technology Stack

- Next.js 16
- React
- TypeScript
- Tailwind CSS
- Gemini API via `@google/genai`
- Prisma 7
- PostgreSQL (Prisma Postgres in production)
- `@prisma/adapter-pg`
- `pdf-parse`
- `mammoth`
- `react-markdown`

---

## Environment Variables

Create a local `.env` file (never commit secrets):

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE"
GEMINI_API_KEY="your-gemini-api-key"
GEMINI_MODEL="gemini-3.5-flash-lite"
```

Production is deployed on Vercel with PostgreSQL/Prisma Postgres and the required environment variables configured in the deployment environment.

## Known Limitations

- Scanned/image-only PDFs are detected and reported, but OCR is not implemented.
- Clause matching is structural and heuristic. Semantically similar clauses with different headings may occasionally appear as separate added/removed items rather than one modified pair.
- The agentic research trace is authoritative for tool activity; the small summary label may not always enumerate locally executed fallback tools.
- Research intentionally does not claim full-document absence when only retrieved sections were substantively inspected.

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