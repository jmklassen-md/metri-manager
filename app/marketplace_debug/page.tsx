"use client";

import React, { useState } from "react";
// @ts-ignore – pdfjs-dist types can be annoying
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.entry";

type SampleLine = {
  page: number;
  text: string;
};

export default function MarketplaceDebugPage() {
  const [lines, setLines] = useState<SampleLine[]>([]);
  const [icons, setIcons] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setLines([]);
    setIcons([]);
    setLoading(true);

    try {
      const arrayBuffer = await file.arrayBuffer();

      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      const allLines: SampleLine[] = [];
      const iconSet = new Set<string>();

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        for (const item of content.items as any[]) {
          const text: string = item.str ?? "";
          if (!text.trim()) continue;

          allLines.push({ page: pageNum, text });

          // scan each character for "weird" / non-ASCII icons
          for (const ch of text) {
            const code = ch.codePointAt(0) ?? 0;
            // Heuristic: capture characters outside the normal ASCII range
            if (code > 126 || code < 32) {
              iconSet.add(`${ch} (U+${code.toString(16).toUpperCase().padStart(4, "0")})`);
            }
          }
        }
      }

      // Keep it sane: only show first 300 lines
      setLines(allLines.slice(0, 300));
      setIcons(Array.from(iconSet));
    } catch (err: any) {
      console.error(err);
      setError("Failed to read PDF – see console for details.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "1rem" }}>
      <h1>Marketplace Debugger</h1>
      <p style={{ marginBottom: "0.75rem" }}>
        Upload a MetricAid PDF here so we can see the <strong>raw text</strong> and
        any <strong>icon characters</strong> it uses for marketplace arrows.
      </p>

      <input
        type="file"
        accept="application/pdf"
        onChange={handleFileChange}
      />

      {loading && <p>Reading PDF…</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {icons.length > 0 && (
        <section style={{ marginTop: "1rem" }}>
          <h2>Detected non-ASCII characters (likely icons)</h2>
          <ul>
            {icons.map((ic) => (
              <li key={ic} style={{ fontFamily: "monospace" }}>
                {ic}
              </li>
            ))}
          </ul>
          <p style={{ fontSize: "0.85rem", color: "#555" }}>
            Each item is shown as: <code>actual-char (U+CODEPOINT)</code>.
            We’ll map these to “giveaway / trade-only / etc.” in the next step.
          </p>
        </section>
      )}

      {lines.length > 0 && (
        <section style={{ marginTop: "1rem" }}>
          <h2>Sample extracted lines (first 300)</h2>
          <div
            style={{
              maxHeight: "400px",
              overflow: "auto",
              border: "1px solid #ccc",
              padding: "0.5rem",
              fontFamily: "monospace",
              fontSize: "0.8rem",
            }}
          >
            {lines.map((l, i) => (
              <div key={i}>
                <span style={{ color: "#888" }}>[page {l.page}] </span>
                {l.text}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
