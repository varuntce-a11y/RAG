(() => {
  "use strict";

  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const DEMO_MARKDOWN = `# Field notes: a better neighborhood garden

The community garden started as an empty lot on Alder Street. In the spring of 2023, twelve neighbors cleared the site and built the first six raised beds.

## Growing together

Today there are 28 active gardeners and 14 shared beds. The group meets on the first Saturday of each month at 10:00 a.m. to plan planting, share harvests, and welcome new members.

Watering is organized in a rotating weekly schedule. Gardeners can trade their week by posting in the shared message group at least one day in advance. A rain gauge is mounted beside the tool shed; beds should be watered only when the gauge shows less than half an inch of rain for the week.

### What we grow

Spring favorites include snap peas, lettuce, radishes, and herbs. Tomatoes, peppers, and eggplant go into the warm-season beds after the last frost, usually around May 15.

\`\`\`text
Garden hours: dawn to dusk
Quiet hours: before 8:00 a.m.
Compost drop-off: the north gate
\`\`\`

## Getting involved

The annual membership contribution is $35 per household. It pays for seeds, shared tools, compost, and the water bill. No one is turned away for inability to pay; ask the volunteer coordinator about a sponsored membership.

Email hello@aldergarden.org to request a plot. New gardeners join a short orientation on the first Saturday of the month. The garden is wheelchair-accessible, with two raised beds designed for seated gardening.

## Looking ahead

This season the group hopes to install a small rainwater tank and add three pollinator beds. The neighborhood association has pledged $600 toward the tank, and a Saturday work party is planned for April 20.`;

  const elements = {
    fileInput: document.querySelector("#file-input"),
    dropZone: document.querySelector("#drop-zone"),
    fileStatus: document.querySelector("#file-status"),
    fileStatusText: document.querySelector("#file-status-text"),
    documentList: document.querySelector("#document-list"),
    docCount: document.querySelector("#doc-count"),
    chunkSize: document.querySelector("#chunk-size"),
    chunkOverlap: document.querySelector("#chunk-overlap"),
    chunkSizeValue: document.querySelector("#chunk-size-value"),
    chunkOverlapValue: document.querySelector("#chunk-overlap-value"),
    chunkSummary: document.querySelector("#chunk-summary-text"),
    chunkPreview: document.querySelector("#chunk-preview"),
    indexButton: document.querySelector("#index-button"),
    conversation: document.querySelector("#conversation"),
    welcomeCard: document.querySelector("#welcome-card"),
    composer: document.querySelector("#composer"),
    questionInput: document.querySelector("#question-input"),
    sendQuestion: document.querySelector("#send-question"),
    topbarDocument: document.querySelector("#topbar-document"),
    sourceViewer: document.querySelector("#source-viewer"),
    sourceLabel: document.querySelector("#source-label"),
    toast: document.querySelector("#toast"),
  };

  const state = { documents: [], activeId: null, method: "hybrid", nextId: 1, toastTimer: null };
  let pdfJsPromise = null;
  let mammothPromise = null;

  function loadMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (mammothPromise) return mammothPromise;
    mammothPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "./node_modules/mammoth/mammoth.browser.min.js";
      script.onload = () => {
        if (window.mammoth) resolve(window.mammoth);
        else {
          mammothPromise = null;
          reject(new Error("The Word document parser did not initialize."));
        }
      };
      script.onerror = () => {
        mammothPromise = null;
        reject(new Error("Could not load the Word document parser. Confirm the app dependencies are installed and reload."));
      };
      document.head.append(script);
    });
    return mammothPromise;
  }

  function loadPdfJs() {
    if (pdfJsPromise) return pdfJsPromise;
    pdfJsPromise = import("./node_modules/pdfjs-dist/build/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("./node_modules/pdfjs-dist/build/pdf.worker.mjs", window.location.href).href;
      return pdfjs;
    }).catch((error) => {
      pdfJsPromise = null;
      throw new Error(`Could not load the PDF parser. Confirm the app dependencies are installed and reload. ${error.message}`);
    });
    return pdfJsPromise;
  }

  async function extractPdf(file) {
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
      const pdf = await loadingTask.promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const rawText = content.items.filter((item) => typeof item.str === "string")
          .map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`).join("");
        const pageText = rawText.split(/\r?\n/u).map((line) => line.replace(/[ \t]+/gu, " ").trim()).filter(Boolean).join("\n");
        if (pageText) pages.push({ pageNumber, text: pageText });
      }
      if (!pages.length) throw new Error("No selectable text was found. This PDF may contain scanned images; OCR is not supported.");
      let text = "";
      const pageRanges = [];
      for (const page of pages) {
        if (text) text += "\n\n";
        const start = text.length;
        text += page.text;
        pageRanges.push({ pageNumber: page.pageNumber, start, end: text.length });
      }
      return { text, pageRanges, pageCount: pdf.numPages };
    } finally {
      await loadingTask.destroy();
    }
  }

  async function extractDocx(file) {
    const mammoth = await loadMammoth();
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    if (!result.value.trim()) throw new Error("No text was found in this Word document.");
    return { text: result.value, warnings: result.messages.filter((message) => message.type === "warning") };
  }

  async function extractDocument(file, type) {
    if (type === "pdf") return extractPdf(file);
    if (type === "docx") return extractDocx(file);
    return { text: await file.text() };
  }

  function shortName(name, max = 26) {
    return name.length > max ? `${name.slice(0, max - 1)}…` : name;
  }

  function prettySize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 3200);
  }

  function activeDocument() {
    return state.documents.find((document) => document.id === state.activeId) || null;
  }

  function setFileStatus(message, status) {
    elements.fileStatusText.textContent = message;
    elements.fileStatus.classList.toggle("ready", status === "ready");
    elements.fileStatus.classList.toggle("error", status === "error");
  }

  function refreshDocumentList() {
    elements.docCount.textContent = String(state.documents.length);
    elements.documentList.replaceChildren();
    if (!state.documents.length) {
      const empty = document.createElement("div");
      empty.className = "empty-docs";
      empty.textContent = "Your library is ready";
      empty.append(document.createElement("br"), "for its first document.");
      elements.documentList.append(empty);
      return;
    }
    for (const item of state.documents) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `document-item${item.id === state.activeId ? " active" : ""}`;
      button.setAttribute("aria-label", `Open ${item.name}`);
      const icon = document.createElement("span");
      icon.className = "doc-icon";
      icon.textContent = item.type === "csv" ? "CSV" : item.type === "txt" ? "TXT" : item.type === "pdf" ? "PDF" : item.type === "docx" ? "DOCX" : "MD";
      const meta = document.createElement("span");
      meta.className = "doc-meta";
      const name = document.createElement("strong");
      name.textContent = shortName(item.name, 25);
      name.title = item.name;
      const details = document.createElement("small");
      details.textContent = item.indexed ? `${item.chunks.length} chunks · indexed` : "Ready to index";
      meta.append(name, details);
      button.append(icon, meta);
      if (item.indexed) {
        const ready = document.createElement("span");
        ready.className = "doc-ready";
        ready.textContent = "✓";
        button.append(ready);
      }
      button.addEventListener("click", () => activateDocument(item.id));
      elements.documentList.append(button);
    }
  }

  function addDocument(name, text, size, isDemo = false, sourceInfo = {}) {
    const type = RagCore.extensionOf(name);
    if (!RagCore.SUPPORTED_EXTENSIONS.has(type)) {
      showToast("Choose a .md, .markdown, .csv, .txt, .pdf, or .docx file.");
      return;
    }
    const chunkSize = Number(elements.chunkSize.value);
    const overlap = Number(elements.chunkOverlap.value);
    let chunked;
    try {
      chunked = RagCore.chunkDocument(text, name, chunkSize, overlap);
    } catch (error) {
      showToast(error.message);
      setFileStatus("Could not read this document", "error");
      return;
    }
    if (sourceInfo.pageRanges) {
      for (const chunk of chunked.chunks) {
        const pages = sourceInfo.pageRanges.filter((page) => chunk.start < page.end && chunk.end > page.start);
        if (pages.length) {
          chunk.pageNumber = pages[0].pageNumber;
          chunk.pageNumbers = pages.map((page) => page.pageNumber);
        }
      }
    }
    if (!text.length || !chunked.chunks.length) {
      showToast("This document has no content to index.");
      setFileStatus("No content to index", "error");
      return;
    }
    const item = {
      id: state.nextId++, name, text, size, type, chunks: chunked.chunks, indexed: false,
      delimiter: chunked.delimiter, headers: chunked.headers, rows: chunked.rows || [], pageCount: sourceInfo.pageCount || null, isDemo,
    };
    state.documents.push(item);
    activateDocument(item.id);
    if (isDemo) showToast("Sample document added — index it to begin.");
  }

  function activateDocument(id) {
    state.activeId = id;
    const item = activeDocument();
    if (!item) return;
    elements.topbarDocument.textContent = shortName(item.name, 34);
    elements.questionInput.disabled = !item.indexed;
    elements.questionInput.placeholder = item.indexed ? `Ask a question about ${shortName(item.name, 28)}…` : "Index this document to start asking questions…";
    elements.sendQuestion.disabled = !item.indexed || !elements.questionInput.value.trim();
    setFileStatus(`${item.name} · ${prettySize(item.size)} · ${item.type.toUpperCase()}${item.indexed ? " · indexed" : ""}`, "ready");
    elements.chunkSize.disabled = item.indexed;
    elements.chunkOverlap.disabled = item.indexed;
    refreshDocumentList();
    refreshPreview(item);
    renderSource(null);
  }

  function refreshPreview(item) {
    const chunks = item.chunks;
    let splitDescription = "Paragraph split";
    if (item.type === "csv") splitDescription = `CSV records · ${item.delimiter === "\t" ? "tab" : item.delimiter} separated`;
    else if (item.type === "md" || item.type === "markdown") splitDescription = "Markdown-aware split";
    else if (item.type === "pdf") splitDescription = `PDF text · ${item.pageCount} pages`;
    else if (item.type === "docx") splitDescription = "Word paragraphs";
    elements.chunkSummary.textContent = chunks.length
      ? `${chunks.length} ${chunks.length === 1 ? "chunk" : "chunks"} · ${splitDescription}`
      : "No text chunks found";
    elements.chunkPreview.replaceChildren();
    if (!chunks.length) {
      const placeholder = document.createElement("div");
      placeholder.className = "preview-placeholder";
      placeholder.textContent = "No chunks to preview";
      elements.chunkPreview.append(placeholder);
      elements.indexButton.disabled = true;
      return;
    }
    for (const chunk of chunks.slice(0, 3)) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "preview-card";
      const top = document.createElement("span");
      top.className = "preview-top";
      const number = document.createElement("strong");
      number.textContent = `CHUNK ${String(chunk.id + 1).padStart(2, "0")}`;
      const length = document.createElement("span");
      length.textContent = `${chunk.end - chunk.start} chars`;
      top.append(number, length);
      const preview = document.createElement("span");
      preview.className = "preview-text";
      const previewText = [chunk.breadcrumb, chunk.text].filter(Boolean).join(" · ");
      preview.textContent = previewText.length > 360 ? `${previewText.slice(0, 357)}…` : previewText;
      card.append(top, preview);
      card.addEventListener("click", () => renderSource({ document: item, chunk }));
      elements.chunkPreview.append(card);
    }
    if (chunks.length > 3) {
      const more = document.createElement("div");
      more.className = "preview-placeholder";
      more.textContent = `＋ ${chunks.length - 3} more chunks`;
      elements.chunkPreview.append(more);
    }
    elements.indexButton.disabled = item.indexed;
    elements.indexButton.innerHTML = item.indexed ? "<span>✓</span> Document indexed" : "<span>✳</span> Index document";
  }

  function rebuildActiveChunks() {
    const item = activeDocument();
    if (!item || item.indexed) return;
    try {
      const chunked = RagCore.chunkDocument(item.text, item.name, Number(elements.chunkSize.value), Number(elements.chunkOverlap.value));
      item.chunks = chunked.chunks;
      item.delimiter = chunked.delimiter;
      item.headers = chunked.headers;
      item.rows = chunked.rows || [];
      elements.chunkSizeValue.textContent = elements.chunkSize.value;
      elements.chunkOverlapValue.textContent = elements.chunkOverlap.value;
      refreshPreview(item);
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderSource(source) {
    elements.sourceViewer.replaceChildren();
    if (!source) {
      elements.sourceLabel.textContent = "NO SOURCE SELECTED";
      const empty = document.createElement("div");
      empty.className = "source-empty";
      const icon = document.createElement("span");
      icon.textContent = "↗";
      const copy = document.createElement("p");
      copy.textContent = "Citations open their source passage here.";
      empty.append(icon, copy);
      elements.sourceViewer.append(empty);
      return;
    }
    const { document: item, chunk } = source;
    elements.sourceLabel.textContent = chunk.rowNumber
      ? `ROW ${chunk.rowNumber.toLocaleString()} · ${chunk.start.toLocaleString()}–${chunk.end.toLocaleString()}`
      : chunk.pageNumber
        ? `PAGE ${chunk.pageNumber.toLocaleString()} · ${chunk.start.toLocaleString()}–${chunk.end.toLocaleString()}`
      : `CHUNK ${String(chunk.id + 1).padStart(2, "0")} · ${chunk.start.toLocaleString()}–${chunk.end.toLocaleString()}`;
    const context = document.createElement("div");
    context.className = "source-context";
    const breadcrumb = document.createElement("span");
    breadcrumb.textContent = chunk.breadcrumb || (chunk.pageNumber ? `Page ${chunk.pageNumbers.join(", ")}` : item.name);
    const file = document.createElement("span");
    file.textContent = item.type.toUpperCase();
    context.append(breadcrumb, file);
    const pre = document.createElement("pre");
    pre.className = "source-text";
    const padding = 320;
    const start = Math.max(0, chunk.start - padding);
    const highlightedEnd = Math.min(chunk.end, chunk.start + 5000);
    const end = Math.min(item.text.length, highlightedEnd + padding);
    const mark = document.createElement("mark");
    mark.textContent = item.text.slice(chunk.start, highlightedEnd);
    pre.append(document.createTextNode(item.text.slice(start, chunk.start)), mark, document.createTextNode(item.text.slice(highlightedEnd, end)));
    if (highlightedEnd < chunk.end) {
      const note = document.createElement("small");
      note.textContent = `Showing first 5,000 characters of this ${chunk.end - chunk.start}-character source chunk.`;
      note.style.display = "block";
      note.style.marginTop = "8px";
      note.style.color = "#92948a";
      note.style.fontFamily = "var(--sans)";
      note.style.fontSize = "9px";
      pre.append(note);
    }
    elements.sourceViewer.append(context, pre);
    const markTop = mark.getBoundingClientRect().top - elements.sourceViewer.getBoundingClientRect().top + elements.sourceViewer.scrollTop;
    elements.sourceViewer.scrollTo({ top: markTop - elements.sourceViewer.clientHeight / 2, behavior: "smooth" });
  }

  function tokenizeSentences(text) {
    return text.split(/(?<=[.!?])\s+|\n+/u).map((sentence) => sentence.trim()).filter(Boolean);
  }

  function bestSentences(query, chunk, count) {
    const queryTerms = new Set(RagCore.tokenize(query).filter((term) => !RagCore.STOP_WORDS.has(term)));
    const content = chunk.content || chunk.text;
    const sentences = tokenizeSentences(content);
    const ranked = sentences.map((sentence, index) => {
      const terms = RagCore.tokenize(sentence);
      let score = 0;
      for (const term of terms) if (queryTerms.has(term)) score += 1 + (sentence.toLocaleLowerCase().includes(term) ? 0.1 : 0);
      return { sentence, index, score };
    }).filter((entry) => entry.score > 0);
    if (!ranked.length) return [sentences.find((sentence) => sentence.length > 24) || content.slice(0, 220)];
    return ranked.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, count).sort((a, b) => a.index - b.index).map((entry) => entry.sentence);
  }

  function appendCitation(reply, sourceDocument, chunk, label) {
    const citation = document.createElement("button");
    citation.type = "button";
    citation.className = "citation";
    citation.textContent = `↗ ${shortName(sourceDocument.name, 17)} · ${label}`;
    citation.title = `Open ${label} in ${sourceDocument.name}`;
    citation.addEventListener("click", () => {
      activateDocument(sourceDocument.id);
      renderSource({ document: sourceDocument, chunk });
    });
    reply.append(document.createTextNode(" "), citation);
  }

  function formatTabularNumber(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }

  function askQuestion() {
    const query = elements.questionInput.value.trim();
    if (!query) return;
    const indexed = state.documents.filter((item) => item.indexed);
    if (!indexed.length) return;
    const currentDocument = activeDocument();
    const csvDocument = currentDocument && currentDocument.indexed && currentDocument.type === "csv" ? currentDocument : null;
    const aggregate = csvDocument ? RagCore.answerCsvMaximum(query, csvDocument) : null;
    const ranked = [];
    for (const item of indexed) {
      for (const result of RagCore.rankChunks(query, item.chunks, state.method, 3)) {
        ranked.push({ ...result, document: item });
      }
    }
    const selected = ranked.sort((a, b) => b.score - a.score).slice(0, 3);
    const message = document.createElement("article");
    message.className = "message";
    const bubble = document.createElement("div");
    bubble.className = "question-bubble";
    bubble.textContent = query;
    message.append(bubble);

    if (aggregate) {
      const answer = document.createElement("div");
      answer.className = "answer";
      const label = document.createElement("div");
      label.className = "answer-label";
      const sparkle = document.createElement("span");
      sparkle.textContent = "✳";
      label.append(sparkle, document.createTextNode(" CSV RESULT · HIGHEST VALUE"));
      answer.append(label);

      for (const winner of aggregate.winners) {
        const reply = document.createElement("p");
        reply.style.margin = "0 0 10px";
        const name = document.createElement("strong");
        name.textContent = winner.name;
        reply.append(
          document.createTextNode(`The ${aggregate.dimensionHeader} with the highest ${aggregate.metricHeader} is `),
          name,
          document.createTextNode(` (${winner.displayValue || formatTabularNumber(winner.value)}).`),
        );
        const sourceChunk = csvDocument.chunks[winner.chunkId];
        if (sourceChunk) {
          appendCitation(reply, csvDocument, {
            ...sourceChunk,
            start: winner.row.start,
            end: winner.row.end,
            rowNumber: winner.rowNumber,
            breadcrumb: `Row ${winner.rowNumber}: ${csvDocument.headers.join(" · ")}`,
          }, `row ${winner.rowNumber}`);
        }
        answer.append(reply);
      }
      message.append(answer);
    } else if (!selected.length) {
      const answer = document.createElement("div");
      answer.className = "answer no-results";
      answer.textContent = "I couldn't find a matching passage in your indexed documents. Try different words or check that the right document is indexed.";
      message.append(answer);
    } else {
      const answer = document.createElement("div");
      answer.className = "answer";
      const label = document.createElement("div");
      label.className = "answer-label";
      const sparkle = document.createElement("span");
      sparkle.textContent = "✳";
      label.append(sparkle, document.createTextNode(" FOUND IN YOUR DOCUMENTS"));
      answer.append(label);

      selected.forEach((result, index) => {
        const reply = document.createElement("p");
        reply.style.margin = "0 0 10px";
        reply.textContent = bestSentences(query, result, index === 0 ? 2 : 1).join(" ");
        const citationLabel = result.pageNumber ? `p.${result.pageNumbers.join(",")}` : String(result.id + 1).padStart(2, "0");
        appendCitation(reply, result.document, result, citationLabel);
        answer.append(reply);
      });
      message.append(answer);
    }
    elements.conversation.append(message);
    elements.welcomeCard.hidden = true;
    elements.questionInput.value = "";
    elements.questionInput.style.height = "27px";
    elements.sendQuestion.disabled = true;
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
  }

  async function processFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setFileStatus("File exceeds the 25 MB limit", "error");
      showToast("This file is over the 25 MB upload limit.");
      return;
    }
    const type = RagCore.extensionOf(file.name);
    if (!RagCore.SUPPORTED_EXTENSIONS.has(type)) {
      setFileStatus("Unsupported file type", "error");
      showToast("Choose a .md, .markdown, .csv, .txt, .pdf, or .docx file.");
      return;
    }
    try {
      setFileStatus(`Reading ${type === "docx" ? "Word" : type.toUpperCase()} document…`, "ready");
      const extracted = await extractDocument(file, type);
      addDocument(file.name, extracted.text, file.size, false, extracted);
      if (extracted.warnings && extracted.warnings.length) {
        showToast(`Word document loaded with a note: ${extracted.warnings[0].message}`);
      }
    } catch (error) {
      setFileStatus("Could not read this file", "error");
      showToast(`Could not read the selected file: ${error.message}`);
    }
  }

  elements.fileInput.addEventListener("change", (event) => {
    processFile(event.target.files[0]);
    event.target.value = "";
  });
  document.querySelector("#welcome-upload").addEventListener("click", () => elements.fileInput.click());
  document.querySelector("#sidebar-add").addEventListener("click", () => elements.fileInput.click());
  document.querySelector("#load-demo").addEventListener("click", () => {
    addDocument("alder-street-garden.md", DEMO_MARKDOWN, new Blob([DEMO_MARKDOWN]).size, true);
  });
  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragover");
  });
  elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragover"));
  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragover");
    processFile(event.dataTransfer.files[0]);
  });
  elements.chunkSize.addEventListener("input", rebuildActiveChunks);
  elements.chunkOverlap.addEventListener("input", rebuildActiveChunks);
  elements.indexButton.addEventListener("click", () => {
    const item = activeDocument();
    if (!item || item.indexed) return;
    item.indexed = true;
    elements.questionInput.disabled = false;
    elements.questionInput.placeholder = `Ask a question about ${shortName(item.name, 28)}…`;
    setFileStatus(`${item.name} · ${prettySize(item.size)} · ${item.type.toUpperCase()} · indexed`, "ready");
    refreshDocumentList();
    refreshPreview(item);
    showToast(`${item.name} indexed — ask away.`);
  });
  document.querySelectorAll(".retrieval-option").forEach((button) => {
    button.addEventListener("click", () => {
      state.method = button.dataset.method;
      document.querySelectorAll(".retrieval-option").forEach((option) => option.classList.toggle("selected", option === button));
    });
  });
  elements.questionInput.addEventListener("input", () => {
    elements.questionInput.style.height = "27px";
    elements.questionInput.style.height = `${Math.min(elements.questionInput.scrollHeight, 120)}px`;
    elements.sendQuestion.disabled = !elements.questionInput.value.trim() || !activeDocument()?.indexed;
  });
  elements.questionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askQuestion();
    }
  });
  elements.sendQuestion.addEventListener("click", askQuestion);
  document.querySelector(".help-button").addEventListener("click", () => {
    showToast("Local-first document Q&A with clickable, exact-offset citations.");
  });
})();
