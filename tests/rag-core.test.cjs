const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const RagCore = require("../rag-core.js");

test("Markdown chunks retain heading breadcrumbs, fenced code, and exact source offsets", () => {
  const source = "# Guide\n\nA useful paragraph.\n\n## Setup\n\n```js\nconst answer = 42;\nconsole.log(answer);\n```\n\nAnother paragraph.";
  const chunks = RagCore.chunkMarkdown(source, 30, 0);
  const codeChunk = chunks.find((chunk) => chunk.text.includes("```js"));
  const codeStart = source.indexOf("```js");
  const codeEnd = source.indexOf("```", codeStart + 3) + 3;

  assert.ok(codeChunk);
  assert.equal(codeChunk.breadcrumb, "Guide / Setup");
  assert.equal(source.slice(codeStart, codeEnd), "```js\nconst answer = 42;\nconsole.log(answer);\n```");
  assert.ok(source.slice(codeChunk.start, codeChunk.end).includes("const answer = 42;"));
  assert.ok(codeChunk.text.includes("const answer = 42;"));
});

test("Setext Markdown headings are carried into chunk breadcrumbs", () => {
  const source = "Garden notes\n============\n\nThe beds need water.";
  const unit = RagCore.markdownUnits(source)[0];

  assert.equal(unit.kind, "heading");
  assert.equal(unit.breadcrumb, "Garden notes");
  assert.equal(source.slice(unit.start, unit.end), "Garden notes\n============");
});

test("CSV parser preserves quoted commas, escaped quotes, and embedded newlines", () => {
  const source = 'name,notes\r\n"River plot","Needs water, compost, and ""shared"" tools"\r\nMina,"Week one\nWeek two"\r\n';
  const { records } = RagCore.parseCsv(source, ",");

  assert.deepEqual(records[0].values, ["name", "notes"]);
  assert.deepEqual(records[1].values, ["River plot", 'Needs water, compost, and "shared" tools']);
  assert.deepEqual(records[2].values, ["Mina", "Week one\nWeek two"]);
  assert.equal(source.slice(records[2].start, records[2].end), 'Mina,"Week one\nWeek two"');
});

test("CSV delimiter detection and record chunks preserve headers and raw row offsets", () => {
  const source = "name;score\nAva;10\nSam;20\n";
  const result = RagCore.chunkDocument(source, "scores.csv", 200, 0);

  assert.equal(result.delimiter, ";");
  assert.deepEqual(result.headers, ["name", "score"]);
  assert.equal(result.chunks.length, 1);
  assert.match(result.chunks[0].content, /Columns: name, score/);
  assert.equal(source.slice(result.chunks[0].start, result.chunks[0].end), "Ava;10\nSam;20");
});

test("CSV highest-revenue questions calculate across every row and identify the exact source row", () => {
  const source = readFileSync(path.join(__dirname, "fixtures", "channel-revenue.csv"), "utf8").trimEnd();
  const document = {
    ...RagCore.chunkDocument(source, "channel-revenue.csv", 200, 0),
  };
  const result = RagCore.answerCsvMaximum("Give me the name of the default channel that brought in the highest purchase revenue", document);

  assert.ok(result);
  assert.equal(result.dimensionHeader, "Session default channel group");
  assert.equal(result.metricHeader, "Purchase revenue");
  assert.equal(result.value, 2500.75);
  assert.equal(result.winners[0].name, "Paid Search");
  assert.equal(result.winners[0].displayValue, "$2,500.75");
  assert.equal(source.slice(result.winners[0].row.start, result.winners[0].row.end), 'Paid Search,"$2,500.75",210');
  assert.equal(document.chunks[result.winners[0].chunkId].rows.includes(result.winners[0].row), true);
});

test("CSV maximum query supports alternate revenue labels, negative values, and ties", () => {
  const source = "Default channel group,Total revenue\nEmail,(25.00)\nOrganic Search,40.5\nPaid Search,40.5";
  const document = RagCore.chunkDocument(source, "revenue.csv", 200, 0);
  const result = RagCore.answerCsvMaximum("Which default channel had the greatest total revenue?", document);

  assert.ok(result);
  assert.equal(result.metricHeader, "Total revenue");
  assert.equal(result.value, 40.5);
  assert.deepEqual(result.winners.map((winner) => winner.name), ["Organic Search", "Paid Search"]);
  assert.equal(RagCore.answerCsvMaximum("What does total revenue mean?", document), null);
  assert.equal(RagCore.parseNumber("€1.2M"), 1200000);
  assert.equal(RagCore.parseNumber("(25.00)"), -25);
});

test("overlap retains whole paragraph units without losing exact source locations", () => {
  const source = "First paragraph has enough text.\n\nSecond paragraph has enough text.\n\nThird paragraph has enough text.";
  const chunks = RagCore.chunkText(source, 40, 20);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks[1].start < chunks[0].end);
  for (const chunk of chunks) assert.equal(source.slice(chunk.start, chunk.end), chunk.text);
});

test("keyword, vector, and hybrid retrieval find relevant source chunks", () => {
  const chunks = [
    { id: 0, breadcrumb: "Garden", content: "The community garden meets on Saturday morning." },
    { id: 1, breadcrumb: "Membership", content: "The annual membership contribution is 35 dollars per household." },
  ];

  for (const method of ["keyword", "vector", "hybrid"]) {
    const ranked = RagCore.rankChunks("How much is the membership contribution?", chunks, method, 1);
    assert.equal(ranked[0].id, 1, `${method} retrieval should rank the membership chunk first`);
  }
});

test("natural-language stop words do not surface otherwise irrelevant chunks", () => {
  const chunks = [
    { id: 0, breadcrumb: "Watering", content: "A rain gauge is mounted beside the tool shed." },
    { id: 1, breadcrumb: "Membership", content: "The annual membership contribution is 35 dollars per household." },
  ];

  for (const method of ["keyword", "vector", "hybrid"]) {
    const ranked = RagCore.rankChunks("How much is the annual membership contribution?", chunks, method, 3);
    assert.deepEqual(ranked.map((chunk) => chunk.id), [1], `${method} retrieval should ignore stop-word-only matches`);
  }
});

test("unsupported extensions and unclosed quoted CSV fields are reported", () => {
  assert.throws(() => RagCore.chunkDocument("hello", "notes.doc", 500, 0), /Choose a Markdown/);
  assert.throws(() => RagCore.parseCsv('name,notes\nAva,"not closed'), /never closed/);
});

test("PDF and Word files are supported as extracted, offset-addressable text", () => {
  const source = "First extracted paragraph.\n\nA second paragraph.";
  for (const name of ["report.pdf", "brief.docx"]) {
    const document = RagCore.chunkDocument(source, name, 200, 0);
    assert.ok(document.chunks.length > 0);
    assert.equal(document.type, RagCore.extensionOf(name));
    for (const chunk of document.chunks) {
      assert.equal(source.slice(chunk.start, chunk.end), chunk.text);
    }
  }
  assert.throws(() => RagCore.chunkDocument("hello", "old-word.doc", 500, 0), /Word \(\.docx\)/);
});
