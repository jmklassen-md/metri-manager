"use client";

import React, { useState } from "react";
// Use the legacy build which is friendlier in bundlers like Next.js
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";

// Disable external worker – use "fake" worker mode in the main thread.
// This is slower but much easier to get working in our small debugging page.
(pdfjsLib as any).GlobalWorkerOptions.workerSrc = "";

type DebugChar = {
  char: string;
  codePoint: number;
  count: number;
};

export default function MarketplaceDebugPage() {
  const [error, setError] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [chars, setChars] = useState<DebugChar[]>([]);
  const [loading, setLoading] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setRawText("");
    setChars([]);
    setLoading(true);

    try {
      const arrayBuffer = await file.arrayBuffer();

      const loadingTask = (pdfjsLib as any).getDocument({
        data: new Uint8Array(arrayBuffer),
        // these options make it a bit more forgiving
        disableFontFace: true,
        useSystemFonts: true,
      });

      const pdf = await loadingTask.promise;
      let fullText = "";

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => ("str" in item ? item.str : ""))
          .join(" ");
        fullText += `\n\n=== PAGE ${pageNum} ===\n\n${pageText}`;
      }

      setRawText(fullText);

      // Character frequency + code points to see how the arrows are encoded
      const counts = new Map<number, number>();
      for (const ch of fullText) {
        const cp = ch.codePointAt(0);
        if (cp === undefined) continue;
        counts.set(cp, (counts.get(cp) || 0) + 1);
      }

      const charArray: DebugChar[] = Array.from(counts.entries())
        .map(([cp, count]) => ({
          char: String.fromCodePoint(cp),
          codePoint: cp,
          count,
        }))
        .sort((a, b) => a.codePoint - b.codePoint);

      setChars(charArray);
    } catch (err) {
      console.error("PDF.js error while reading marketplace PDF:", err);
      setError("Failed to read PDF – see console for details.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: "1rem auto", padding: "1rem" }}>
      <h1>Marketplace Debugger</h1>
      <p>
        Upload a MetricAid PDF here so we can inspect the <strong>raw text</strong>{" "}
        and any <strong>icon characters</strong> used for marketplace arrows.
      </p>

      <input type="file" accept="application/pdf" onChange={handleFileChange} />

      {loading && <p style={{ color: "#555" }}>Reading PDF…</p>}

      {error && (
        <p style={{ color: "red", marginTop: "1rem" }}>{error}</p>
      )}

      {rawText && (
        <>
          <h2 style={{ marginTop: "1.5rem" }}>Raw Text (first 10,000 chars)</h2>
          <pre
            style={{
              maxHeight: 300,
              overflow: "auto",
              background: "#f5f5f5",
              padding: "0.5rem",
              whiteSpace: "pre-wrap",
            }}
          >
            {rawText.slice(0, 10000)}
          </pre>
        </>
      )}

      {chars.length > 0 && (
        <>
          <h2 style={{ marginTop: "1.5rem" }}>Character Table</h2>
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            Look especially for odd symbols with codepoints above 127 – those are
            likely the orange arrows / marketplace icons.
          </p>
          <div style={{ maxHeight: 300, overflow: "auto" }}>
            <table
              border={1}
              cellPadding={4}
              style={{ borderCollapse: "collapse", width: "100%" }}
            >
              <thead>
                <tr>
                  <th>Char</th>
                  <th>Code Point</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {chars.map((c) => (
                  <tr key={c.codePoint}>
                    <td style={{ textAlign: "center" }}>{c.char}</td>
                    <td>{c.codePoint}</td>
                    <td>{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
