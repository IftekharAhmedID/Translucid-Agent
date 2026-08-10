import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildAgentInputManifest,
  isSparseDocument,
  isSparsePage,
  MAX_PDF_PAGES,
  pdfTextItemsToLines,
  wrapExtractedText,
} from "../src/core/input.ts";

const inputDirectory = "/workspace/case/input";

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr.slice(0, 500)}`)));
  });
}

async function extractPdf(pdfPath: string) {
  const bytes = await readFile(pdfPath);
  const document = await getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false }).promise;
  if (document.numPages > MAX_PDF_PAGES) throw new Error(`PDF has ${document.numPages} pages; the limit is ${MAX_PDF_PAGES}.`);
  const pages: Array<{
    page: number;
    lines: Array<{ line: number; text: string }>;
    text: string;
    characterCount: number;
    sparse: boolean;
    links: string[];
    imagePath?: string;
  }> = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = pdfTextItemsToLines(content.items.flatMap((item) => "str" in item ? [{ str: item.str, hasEOL: item.hasEOL }] : []));
    const text = lines.join("\n");
    const annotations = await page.getAnnotations();
    const links = [...new Set(annotations.flatMap((annotation) => typeof annotation.url === "string" ? [annotation.url] : []))];
    pages.push({
      page: pageNumber,
      lines: lines.map((line, index) => ({ line: index + 1, text: line })),
      text,
      characterCount: text.replace(/\s/g, "").length,
      sparse: isSparsePage(text),
      links,
    });
  }
  const sparseDocument = isSparseDocument(pages.map((page) => page.text));
  const renderDirectory = join(inputDirectory, "sparse-pages");
  await mkdir(renderDirectory, { recursive: true });
  for (const page of pages) {
    if (!page.sparse && !sparseDocument) continue;
    const outputRoot = join(renderDirectory, `page-${String(page.page).padStart(3, "0")}`);
    await run("pdftoppm", ["-f", String(page.page), "-l", String(page.page), "-r", "144", "-png", "-singlefile", pdfPath, outputRoot]);
    page.sparse = true;
    page.imagePath = `${outputRoot}.png`;
  }
  const cleanTextPath = join(inputDirectory, "resume.clean.txt");
  const documentPath = join(inputDirectory, "resume.document.json");
  const cleanText = pages.map((page) => {
    const links = page.links.length ? `\nLinks extracted from PDF annotations:\n${page.links.map((url) => `- ${url}`).join("\n")}` : "";
    return `--- Page ${page.page} ---\n${page.lines.map(({ text }) => wrapExtractedText(text)).join("\n")}${links}`;
  }).join("\n\n");
  await writeFile(cleanTextPath, cleanText);
  await writeFile(documentPath, JSON.stringify({
    schemaVersion: 1,
    extractionMethod: "PDF.js 6.2.108",
    pageCount: pages.length,
    pages,
  }, null, 2));
  return {
    cleanTextPath,
    documentPath,
    pageCount: pages.length,
    sparsePageNumbers: pages.filter((page) => page.sparse).map((page) => page.page),
    linkCount: pages.reduce((total, page) => total + page.links.length, 0),
  };
}

async function main() {
  await mkdir(inputDirectory, { recursive: true });
  const manifestPath = join(inputDirectory, "manifest.json");
  const seed = JSON.parse(await readFile(join(inputDirectory, "intake.json"), "utf8")) as Record<string, unknown> & { pdfPath?: unknown };
  let parsedDocument: Record<string, unknown> | undefined;
  if (typeof seed.pdfPath === "string") {
    parsedDocument = await extractPdf(seed.pdfPath);
    await unlink(seed.pdfPath);
  }
  await writeFile(manifestPath, JSON.stringify(buildAgentInputManifest(seed, parsedDocument), null, 2));
}

await main();
