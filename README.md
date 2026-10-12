# Paragraph RAG

A local-first document Q&A app. Drop in a Markdown, CSV, text, PDF, or Word (`.docx`) file, preview how it will be chunked, adjust chunk size and overlap, index it, then ask questions and follow citations back to highlighted source passages.

## Run locally

From this directory, start a static server:

```powershell
npm.cmd install
python -m http.server 4173 --bind 127.0.0.1
```

Then open <http://127.0.0.1:4173>.

## Test

```powershell
node --test tests/rag-core.test.cjs
```

Uploads are processed in the browser and limited to 25 MB. PDF text is extracted page by page with PDF.js; Word `.docx` text is extracted with Mammoth. File bytes stay in the browser. PDF citations include page numbers, and the source viewer highlights the corresponding extracted text. Image-only/scanned PDFs without selectable text are not OCR-processed. Markdown chunking preserves paragraph and fenced-code boundaries while adding heading breadcrumbs; CSV chunking parses quoted fields, embedded line breaks, and comma, tab, semicolon, or pipe delimiters. Text and CSV locations use JavaScript string offsets into the original text; PDF and Word offsets refer to locally extracted text.

Retrieval offers BM25 keyword ranking, local TF-IDF sparse-vector cosine ranking, or reciprocal-rank hybrid search. For CSV questions asking for the highest or largest value (for example, which channel brought in the most purchase revenue), the app evaluates matching numeric and category columns across every row and cites the winning source row. No document is sent to a server or external model.
