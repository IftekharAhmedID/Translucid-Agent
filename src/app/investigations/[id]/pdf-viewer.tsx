"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

export function PdfViewer({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void import("pdfjs-dist/legacy/build/pdf.mjs").then(async (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      const loaded = await pdfjs.getDocument({ url }).promise;
      if (cancelled) return;
      documentRef.current = loaded;
      setPages(loaded.numPages);
    }).catch(() => setError("The original PDF could not be rendered."));
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => {
    const target = canvas.current;
    const document = documentRef.current;
    if (!target || !document || !pages) return;
    let cancelled = false;
    void document.getPage(page).then(async (pdfPage) => {
      const viewport = pdfPage.getViewport({ scale: 1.35 });
      const context = target.getContext("2d");
      if (!context || cancelled) return;
      target.width = viewport.width; target.height = viewport.height;
      await pdfPage.render({ canvas: target, canvasContext: context, viewport }).promise;
    }).catch(() => setError("This PDF page could not be rendered."));
    return () => { cancelled = true; };
  }, [page, pages]);

  if (error) return <p className="form-error">{error}</p>;
  return <div className="pdf-viewer"><div className="pdf-toolbar"><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>Previous</button><span>Page {page} of {pages || "…"}</span><button type="button" onClick={() => setPage((value) => Math.min(pages, value + 1))} disabled={!pages || page >= pages}>Next</button></div><div className="pdf-canvas-wrap"><canvas ref={canvas} aria-label={`PDF page ${page}`} /></div></div>;
}
