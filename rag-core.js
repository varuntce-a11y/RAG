(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.RagCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SUPPORTED_EXTENSIONS = new Set(["md", "markdown", "csv", "txt", "pdf", "docx"]);
  const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it", "me", "of", "on", "or", "our", "please", "the", "their", "this", "to", "was", "we", "what", "when", "where", "which", "who", "why", "with", "you"]);

  function extensionOf(name) {
    const match = /\.([^.]+)$/.exec(name);
    return match ? match[1].toLowerCase() : "";
  }

  function tokenize(text) {
    return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  }

  function markdownUnits(text) {
    const lines = [];
    let offset = 0;
    for (const line of text.match(/.*(?:\r\n|\n|\r|$)/g) || []) {
      if (line.length === 0) continue;
      const content = line.replace(/(?:\r\n|\n|\r)$/, "");
      lines.push({ content, start: offset, end: offset + content.length });
      offset += line.length;
    }

    const units = [];
    const headings = [];
    let paragraph = null;
    let paragraphLineCount = 0;
    let fenced = false;
    let fenceCharacter = "";
    let fenceLength = 0;
    let fenceUnit = null;

    function flushParagraph() {
      if (paragraph) units.push({ ...paragraph, breadcrumb: headings.map((heading) => heading.text).join(" / "), kind: "paragraph" });
      paragraph = null;
      paragraphLineCount = 0;
    }

    for (const line of lines) {
      const fence = /^\s*(`{3,}|~{3,})/.exec(line.content);
      if (fenced) {
        if (fenceUnit) fenceUnit.end = line.end;
        if (fence && fence[1][0] === fenceCharacter && fence[1].length >= fenceLength) {
          fenced = false;
          if (fenceUnit) {
            fenceUnit.breadcrumb = headings.map((heading) => heading.text).join(" / ");
            fenceUnit.kind = "code";
            units.push(fenceUnit);
            fenceUnit = null;
          }
        }
        continue;
      }
      if (fence) {
        flushParagraph();
        fenced = true;
        fenceCharacter = fence[1][0];
        fenceLength = fence[1].length;
        fenceUnit = { start: line.start, end: line.end };
        continue;
      }

      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.content);
      if (heading) {
        flushParagraph();
        const level = heading[1].length;
        headings.length = level - 1;
        headings[level - 1] = { level, text: heading[2].trim() };
        units.push({ start: line.start, end: line.end, breadcrumb: headings.map((item) => item.text).join(" / "), kind: "heading" });
        continue;
      }

      const setext = /^\s*(=+|-+)\s*$/.exec(line.content);
      if (setext && paragraph && paragraphLineCount === 1) {
        const level = setext[1][0] === "=" ? 1 : 2;
        const title = text.slice(paragraph.start, paragraph.end).trim();
        const start = paragraph.start;
        headings.length = level - 1;
        headings[level - 1] = { level, text: title };
        paragraph = null;
        paragraphLineCount = 0;
        units.push({ start, end: line.end, breadcrumb: headings.map((item) => item.text).join(" / "), kind: "heading" });
        continue;
      }

      if (!line.content.trim()) {
        flushParagraph();
        continue;
      }

      if (!paragraph) {
        paragraph = { start: line.start, end: line.end };
        paragraphLineCount = 1;
      } else {
        paragraph.end = line.end;
        paragraphLineCount += 1;
      }
    }

    flushParagraph();
    if (fenceUnit) {
      fenceUnit.breadcrumb = headings.map((heading) => heading.text).join(" / ");
      fenceUnit.kind = "code";
      units.push(fenceUnit);
    }
    return units;
  }

  function detectDelimiter(text) {
    const candidates = [",", "\t", ";", "|"];
    const counts = new Map(candidates.map((candidate) => [candidate, []]));
    let inQuotes = false;
    let fieldsForLine = new Map(candidates.map((candidate) => [candidate, 0]));
    let sampledLines = 0;
    for (let i = 0; i < text.length && sampledLines < 12; i += 1) {
      const char = text[i];
      if (char === '"') {
        if (inQuotes && text[i + 1] === '"') i += 1;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && (char === "\n" || char === "\r")) {
        for (const candidate of candidates) counts.get(candidate).push(fieldsForLine.get(candidate));
        fieldsForLine = new Map(candidates.map((candidate) => [candidate, 0]));
        sampledLines += 1;
        if (char === "\r" && text[i + 1] === "\n") i += 1;
      } else if (!inQuotes && counts.has(char)) {
        fieldsForLine.set(char, fieldsForLine.get(char) + 1);
      }
    }
    for (const candidate of candidates) {
      const partialCount = fieldsForLine.get(candidate);
      if (partialCount > 0 && sampledLines < 12) counts.get(candidate).push(partialCount);
    }
    let best = ",";
    let bestScore = 0;
    for (const candidate of candidates) {
      const samples = counts.get(candidate).filter((count) => count > 0);
      if (!samples.length) continue;
      const mean = samples.reduce((sum, count) => sum + count, 0) / samples.length;
      const variance = samples.reduce((sum, count) => sum + (count - mean) ** 2, 0) / samples.length;
      const score = mean - Math.sqrt(variance);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  function parseCsv(text, delimiter) {
    const separator = delimiter || detectDelimiter(text);
    const records = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let recordStart = 0;
    let i = 0;

    while (i < text.length) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"' && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        if (char === '"') inQuotes = false;
        else field += char;
        i += 1;
        continue;
      }

      if (char === '"' && field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (char === separator) {
        row.push(field);
        field = "";
        i += 1;
        continue;
      }
      if (char === "\n" || char === "\r") {
        row.push(field);
        const recordEnd = i;
        if (row.some((value) => value.trim() !== "")) records.push({ values: row, start: recordStart, end: recordEnd });
        row = [];
        field = "";
        i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
        recordStart = i;
        continue;
      }
      field += char;
      i += 1;
    }
    row.push(field);
    if (row.some((value) => value.trim() !== "")) records.push({ values: row, start: recordStart, end: text.length });
    if (inQuotes) throw new Error("This CSV file has a quoted field that was never closed.");
    return { delimiter: separator, records };
  }

  function groupUnits(units, text, maxChars, overlap, metadata) {
    const limit = Math.max(1, Number(maxChars) || 800);
    const overlapSize = Math.max(0, Number(overlap) || 0);
    const chunks = [];
    let startIndex = 0;

    while (startIndex < units.length) {
      let endIndex = startIndex;
      while (endIndex + 1 < units.length && units[endIndex].end - units[startIndex].start < limit) endIndex += 1;
      const first = units[startIndex];
      const last = units[endIndex];
      const details = metadata ? metadata(first, last, startIndex, endIndex) : {};
      chunks.push({
        id: chunks.length,
        start: first.start,
        end: last.end,
        text: text.slice(first.start, last.end),
        breadcrumb: first.breadcrumb || "",
        content: details.content || [first.breadcrumb, text.slice(first.start, last.end)].filter(Boolean).join("\n"),
        ...details,
      });
      if (endIndex >= units.length - 1) break;
      let nextIndex = endIndex + 1;
      let retainedLength = 0;
      while (nextIndex > startIndex && retainedLength < overlapSize) {
        nextIndex -= 1;
        retainedLength = units[endIndex].end - units[nextIndex].start;
      }
      startIndex = Math.max(startIndex + 1, nextIndex);
    }
    return chunks;
  }

  function chunkMarkdown(text, maxChars, overlap) {
    return groupUnits(markdownUnits(text), text, maxChars, overlap);
  }

  function chunkCsv(text, maxChars, overlap, delimiter) {
    const parsed = parseCsv(text, delimiter);
    if (parsed.records.length < 2) return { delimiter: parsed.delimiter, headers: parsed.records[0] ? parsed.records[0].values : [], chunks: [] };
    const headers = parsed.records[0].values.map((value, index) => value.trim() || `Column ${index + 1}`);
    const rows = parsed.records.slice(1).map((record, index) => ({ ...record, rowNumber: index + 2, chunkId: null }));
    const chunks = groupUnits(rows, text, maxChars, overlap, (first, last, startIndex, endIndex) => {
      const content = rows.slice(startIndex, endIndex + 1).map((record) => record.values.map((value, index) => `${headers[index] || `Column ${index + 1}`}: ${value}`).join(" | ")).join("\n");
      return { content: `Columns: ${headers.join(", ")}\n${content}`, breadcrumb: headers.join(" · "), records: endIndex - startIndex + 1, rows: rows.slice(startIndex, endIndex + 1) };
    });
    for (const chunk of chunks) {
      for (const row of chunk.rows) {
        if (row.chunkId === null) row.chunkId = chunk.id;
      }
    }
    return { delimiter: parsed.delimiter, headers, rows, chunks };
  }

  function chunkText(text, maxChars, overlap) {
    return groupUnits(markdownUnits(text), text, maxChars, overlap);
  }

  function chunkDocument(text, name, maxChars, overlap) {
    const extension = extensionOf(name);
    if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error("Choose a Markdown (.md, .markdown), CSV (.csv), text (.txt), PDF (.pdf), or Word (.docx) file.");
    if (extension === "csv") {
      const parsed = chunkCsv(text, maxChars, overlap);
      return { ...parsed, type: extension, chunks: parsed.chunks };
    }
    return { type: extension, delimiter: null, headers: [], chunks: chunkText(text, maxChars, overlap) };
  }

  function bm25(query, documents) {
    const terms = tokenize(query).filter((term) => !STOP_WORDS.has(term));
    if (!terms.length || !documents.length) return documents.map(() => 0);
    const tokenized = documents.map((document) => tokenize(document));
    const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / tokenized.length || 1;
    const documentFrequency = new Map();
    for (const tokens of tokenized) {
      for (const term of new Set(tokens)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
    return tokenized.map((tokens) => {
      const frequencies = new Map();
      for (const term of tokens) frequencies.set(term, (frequencies.get(term) || 0) + 1);
      let score = 0;
      for (const term of new Set(terms)) {
        const frequency = frequencies.get(term) || 0;
        if (!frequency) continue;
        const df = documentFrequency.get(term) || 0;
        const inverseFrequency = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const k1 = 1.2;
        const b = 0.75;
        score += inverseFrequency * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * tokens.length / averageLength)));
      }
      return score;
    });
  }

  function tfidfVectors(documents) {
    const tokenized = documents.map((document) => tokenize(document));
    const documentFrequency = new Map();
    for (const tokens of tokenized) {
      for (const term of new Set(tokens)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
    return tokenized.map((tokens) => {
      const counts = new Map();
      for (const term of tokens) counts.set(term, (counts.get(term) || 0) + 1);
      const vector = new Map();
      let magnitude = 0;
      for (const [term, count] of counts) {
        const weight = (1 + Math.log(count)) * (Math.log(1 + documents.length / (1 + (documentFrequency.get(term) || 0))) + 1);
        vector.set(term, weight);
        magnitude += weight * weight;
      }
      return { vector, magnitude: Math.sqrt(magnitude) || 1 };
    });
  }

  function vectorScores(query, documents) {
    const queryTerms = tokenize(query).filter((term) => !STOP_WORDS.has(term));
    const allDocuments = documents.concat([queryTerms.join(" ")]);
    const vectors = tfidfVectors(allDocuments);
    const queryVector = vectors.pop();
    return vectors.map(({ vector, magnitude }) => {
      let dot = 0;
      for (const [term, weight] of queryVector.vector) dot += weight * (vector.get(term) || 0);
      return dot / (magnitude * queryVector.magnitude);
    });
  }

  function rankChunks(query, chunks, method, limit) {
    const docs = chunks.map((chunk) => `${chunk.breadcrumb || ""} ${chunk.content || chunk.text || ""}`);
    const keywordScores = bm25(query, docs);
    const embeddingScores = vectorScores(query, docs);
    const keywordOrder = keywordScores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    const vectorOrder = embeddingScores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    const keywordRank = new Map(keywordOrder.map((entry, rank) => [entry.index, rank]));
    const vectorRank = new Map(vectorOrder.map((entry, rank) => [entry.index, rank]));
    const scored = chunks.map((chunk, index) => {
      let score;
      if (method === "keyword") score = keywordScores[index];
      else if (method === "vector") score = embeddingScores[index];
      else score = 1 / (60 + keywordRank.get(index)) + 1 / (60 + vectorRank.get(index));
      return { ...chunk, score, keywordScore: keywordScores[index], vectorScore: embeddingScores[index] };
    }).filter((chunk) => chunk.keywordScore > 0 || chunk.vectorScore > 0);
    return scored.sort((a, b) => b.score - a.score).slice(0, limit || 4);
  }

  function parseNumber(value) {
    const text = String(value).trim();
    if (!text) return null;
    const parenthesized = /^\(.*\)$/.test(text);
    const suffix = /([kmb])\s*$/i.exec(text);
    const normalized = text.replace(/[,\s$€£¥₹%]/g, "").replace(/[^\d.+-]/g, "");
    if (!normalized || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
    const number = Number(normalized) * (suffix ? ({ k: 1e3, m: 1e6, b: 1e9 }[suffix[1].toLowerCase()]) : 1);
    if (!Number.isFinite(number)) return null;
    return parenthesized ? -Math.abs(number) : number;
  }

  function answerCsvMaximum(query, document) {
    const terms = tokenize(query).filter((term) => !STOP_WORDS.has(term));
    if (!/\b(highest|largest|greatest|maximum|max|biggest|most|top)\b/i.test(query)) return null;

    const metricTerms = new Set(["purchase", "revenue", "sales", "sale", "amount", "value", "profit", "income", "spend", "spending", "cost", "orders", "conversions"]);
    const queryMetricTerms = new Set(terms.filter((term) => metricTerms.has(term)));
    if (!queryMetricTerms.size) return null;
    const queryDimensionTerms = new Set(terms.filter((term) => !metricTerms.has(term) && !["highest", "largest", "greatest", "maximum", "max", "biggest", "most", "top", "brought"].includes(term)));

    const headers = document.headers || [];
    const rows = document.rows || [];
    if (!headers.length || !rows.length) return null;
    const columns = headers.map((header, index) => {
      const headerTerms = tokenize(header);
      const numericValues = rows.map((row) => parseNumber(row.values[index]));
      const numberCount = numericValues.filter((value) => value !== null).length;
      const overlap = headerTerms.filter((term) => queryMetricTerms.has(term)).length;
      const metricBonus = headerTerms.some((term) => ["revenue", "sales", "amount", "value", "profit", "income", "spend", "spending", "cost"].includes(term)) ? 1 : 0;
      return { index, header, headerTerms, numericValues, numberCount, metricScore: overlap + metricBonus };
    });
    const metric = columns
      .filter((column) => column.numberCount > 0 && column.metricScore > 0)
      .sort((a, b) => b.metricScore - a.metricScore || b.numberCount - a.numberCount)[0];
    if (!metric) return null;

    const dimension = columns.map((column) => {
      const queryOverlap = column.headerTerms.filter((term) => queryDimensionTerms.has(term)).length;
      const channelBonus = queryDimensionTerms.has("channel") && column.headerTerms.includes("channel") ? 2 : 0;
      const defaultBonus = queryDimensionTerms.has("default") && column.headerTerms.includes("default") ? 2 : 0;
      return { ...column, dimensionScore: queryOverlap + channelBonus + defaultBonus };
    }).filter((column) => column.index !== metric.index && column.numberCount < rows.length)
      .filter((column) => column.dimensionScore > 0)
      .sort((a, b) => b.dimensionScore - a.dimensionScore)[0];
    if (!dimension) return null;

    const validRows = rows.map((row, index) => ({ row, index, value: metric.numericValues[index] }))
      .filter((entry) => entry.value !== null && String(entry.row.values[dimension.index] || "").trim() !== "");
    if (!validRows.length) return null;
    const maximum = validRows.reduce((highest, entry) => Math.max(highest, entry.value), Number.NEGATIVE_INFINITY);
    const winners = validRows.filter((entry) => entry.value === maximum).map(({ row, value }) => ({
      name: String(row.values[dimension.index]).trim(),
      value,
      displayValue: String(row.values[metric.index]).trim(),
      row,
      chunkId: row.chunkId,
      rowNumber: row.rowNumber,
    }));
    return { metricHeader: metric.header, dimensionHeader: dimension.header, value: maximum, winners };
  }

  return { SUPPORTED_EXTENSIONS, STOP_WORDS, extensionOf, tokenize, markdownUnits, detectDelimiter, parseCsv, chunkMarkdown, chunkCsv, chunkText, chunkDocument, bm25, vectorScores, rankChunks, parseNumber, answerCsvMaximum };
});
