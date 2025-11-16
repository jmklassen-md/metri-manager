"use client";

import React, { useEffect, useState } from "react";

declare global {
  interface Window {
    pdfjsLib?: any;
  }
}

export default function MarketplaceDebugPage() {
  const [pdfReady, setPdfReady] = useState(false);
  const [loadingScript, setLoadingScript] = useState(true);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string>("");
  const [uniqueChars, setUniqueChars] = useState<string[]>([]);

  // Load PDF.js from CDN (browser only)
  useEffect(() => {
    if (typeof window === "undefined") return;

    // If already loaded, don’t load again
    if (window.pdfjsLib) {
      setPdfReady(true);
      setLoadingScript(false);
      return;
    }

    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.async = true;
    script.onload = () => {
      setLoadingScript(false);
      if (window.pdfjsLib) {
        setPdfReady(true);
      } else {
        setError("PDF.js script loaded, but pdfjsLib is not available.");
      }
    };
    script.onerror = () => {
      setLoadingScript(false);
      setError("Failed to load PDF.js from CDN.");
    };

    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setStatus("");
    setRawText("");
    setUniqueChars([]);

    if (!pdfReady || !window.pdfjsLib) {
      setError("PDF.js is not ready yet. Wait a moment and try again.");
      return;
    }

    try {
      setStatus(`Reading "${file.name}"…`);

      const arrayBuffer = await file.arrayBuffer();
      const pdfjsLib = window.pdfjsLib;

      // Tell PDF.js we’re using in-browser worker-less mode
      pdfjsLib.GlobalWorkerOptions.workerSrc = undefined;

      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      let combinedText = "";

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item: any) => (item && item.str ? item.str : ""))
          .join("");

        combinedText += `\n\n----- PAGE ${pageNum} -----\n${pageText}`;
      }

      setRawText(combinedText);

      // Collect unique characters (to spot arrow glyphs etc.)
      const charSet = new Set<string>();
      for (const ch of combinedText) {
        if (ch !== "\n" && ch !== "\r") {
          charSet.add(ch);
        }
      }
      const charsArray = Array.from(charSet).sort((a, b) =>
        a.localeCompare(b)
      );
      setUniqueChars(charsArray);

      setStatus(
        `Parsed ${pdf.numPages} page(s). Scroll down to see raw text and unique characters.`
      );
    } catch (err: any) {
      console.error("Error reading PDF:", err);
      setError("Failed to read PDF – check console for details.");
      setStatus("");
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "1rem" }}>
      <h1>Marketplace Debugger</h1>
      <p>
        Upload a MetricAid PDF here so we can inspect the{" "}
        <strong>raw text</strong> and the{" "}
        <strong>unique characters</strong> used for marketplace arrows / icons.
      </p>

      <div style={{ margin: "1rem 0" }}>
        <input type="file" accept="application/pdf" onChange={handleFileChange} />
      </div>

      {loadingScript && (
        <p style={{ color: "#6b7280" }}>Loading PDF.js library…</p>
      )}

      {status && <p style={{ color: "#16a34a" }}>{status}</p>}
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}

      {uniqueChars.length > 0 && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2>Unique characters detected</h2>
          <p style={{ fontSize: "0.9rem", color: "#4b5563" }}>
            These are all distinct characters that appear in the extracted text.
            Look for weird symbols that might correspond to the marketplace
            arrows.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
              padding: "0.5rem",
              border: "1px solid #e5e7eb",
              borderRadius: 4,
            }}
          >
            {uniqueChars.map((ch, i) => (
              <span
                key={i}
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 4,
                  padding: "0.15rem 0.35rem",
                  fontFamily: "monospace",
                }}
                title={`U+${ch.charCodeAt(0).toString(16).toUpperCase()}`}
              >
                {ch === " " ? "␣" : ch}
              </span>
            ))}
          </div>
        </section>
      )}

      {rawText && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2>Raw extracted text</h2>
          <p style={{ fontSize: "0.9rem", color: "#4b5563" }}>
            This is the text that PDF.js sees on each page. Icons might appear
            as strange characters here.
          </p>
          <textarea
            value={rawText}
            readOnly
            style={{
              width: "100%",
              height: "400px",
              fontFamily: "monospace",
              fontSize: "0.8rem",
              whiteSpace: "pre",
            }}
          />
        </section>
      )}
    </main>
  );
}
