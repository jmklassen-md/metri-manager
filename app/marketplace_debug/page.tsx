"use client";

import React, { useState } from "react";
// Import the main pdfjs-dist bundle
import * as pdfjsLib from "pdfjs-dist";

// Run PDF.js in "fake worker" mode (main thread). Slower but simple.
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
      const arrayBuffer =
