"use client";

import React, { useState } from "react";
import * as XLSX from "xlsx";

type Shift = {
  date: string;       // "2025-11-17"
  shiftName: string;  // "R5", "Surge-AM", etc.
  startTime: string;  // "05:00"
  endTime: string;    // "09:00"
  doctor: string;     // e.g. "Klassen"
  rawCell: string;    // original text for debugging
};

/** Detect cells like "Mon, Nov 17" */
function isDateHeader(value: string): boolean {
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value.trim());
}

/** Convert "Mon, Nov 17" to "2025-11-17" (or whatever year) */
function normalizeDate(header: string, fallbackYear?: number): string | null {
  // Example header: "Mon, Nov 17"
  const parts = header.replace(",", "").split(/\s+/); // ["Mon", "Nov", "17"]
  if (parts.length < 3) return null;

  const monthStr = parts[1];
  const dayStr = parts[2];

  const monthMap: Record<string, number> = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };

  const m = monthMap[monthStr as keyof typeof monthMap];
  if (m === undefined) return null;

  const day = parseInt(dayStr, 10);
  if (!Number.isFinite(day)) return null;

  const year = fallbackYear ?? new Date().getFullYear();
  const d = new Date(year, m, day);
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

/** Heuristic doctor-name extractor from the "names" row */
function extractDoctorName(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "--") return "";

  // Often looks like "KlassenMa (FRCP R3) / Luo (M3)"
  // Grab the first letter run as the doc's last name.
  const match = trimmed.match(/[A-Za-z]+/);
  return match ? match[0] : trimmed;
}

/** Parse the MetricAid schedule-style XLSX into a list of shifts */
function parseMarketplaceXlsx(arrayBuffer: ArrayBuffer): Shift[] {
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const ref = sheet["!ref"];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);

  // Keep track of the active date for each column (7 columns = days)
  const datesByCol: (string | null)[] = new Array(range.e.c + 1).fill(null);

  const shifts: Shift[] = [];

  // Guess a reasonable year from the first header we see
  let detectedYear: number | undefined;

  for (let r = range.s.r; r <= range.e.r; r++) {
    // First pass on this row: update any date headers
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddr];
      const v = typeof cell?.v === "string" ? cell.v.trim() : "";

      if (!v) continue;

      if (isDateHeader(v)) {
        // Try to detect / lock in a year
        if (!detectedYear && cell?.w) {
          // If Excel stored a richer formatted date, we might get the year from cell.w
          const maybeYear = (cell.w.match(/\b(20\d{2})\b/) || [])[1];
          if (maybeYear) detectedYear = parseInt(maybeYear, 10);
        }

        const normalized = normalizeDate(v, detectedYear);
        if (normalized) {
          datesByCol[c] = normalized;
        }
      }
    }

    // Second pass on this row: look for shift cells (location + shift + times)
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddr];
      const value = typeof cell?.v === "string" ? cell.v : "";
      if (!value) continue;

      const activeDate = datesByCol[c];
      if (!activeDate) continue; // we don't know which day this column is yet

      // Take the last line in the cell (e.g. "R22 - 22:00-02:00")
      const lines = value.split(/\r?\n/);
      const lastLine = lines[lines.length - 1].trim();

      // Match "SHIFTNAME - 08:00-17:00"
      const m = lastLine.match(
        /^(.+?)\s*-\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/
      );
      if (!m) continue;

      const shiftName = m[1].trim();
      const startTime = m[2].padStart(5, "0");
      const endTime = m[3].padStart(5, "0");

      // Look at the *next* row in same column for names ("Klassen", "--", etc)
      const docCellAddr = XLSX.utils.encode_cell({ r: r + 1, c });
      const docCell = sheet[docCellAddr];
      const docText = typeof docCell?.v === "string" ? docCell.v : "";
      const doctor = extractDoctorName(docText);

      shifts.push({
        date: activeDate,
        shiftName,
        startTime,
        endTime,
        doctor,
        rawCell: value,
      });
    }
  }

  return shifts;
}

export default function MarketplaceXlsxPage() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setLoading(true);
    setShifts([]);

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseMarketplaceXlsx(buffer);
      setShifts(parsed);
      if (parsed.length === 0) {
        setError(
          "Parsed 0 shifts from this file. The layout might be different than expected."
        );
      }
    } catch (err: any) {
      console.error(err);
      setError("Failed to read XLSX – check console for details.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Marketplace XLSX Parser (Prototype)</h1>
      <p>
        Upload a MetricAid <code>.xlsx</code> export (the one that includes your
        own schedule + marketplace). This tool will try to pull out individual
        shifts: date, shift name, times, and primary doctor.
      </p>

      <div style={{ margin: "1rem 0" }}>
        <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />
      </div>

      {loading && <p>Reading and parsing XLSX…</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {shifts.length > 0 && (
        <>
          <p>
            Parsed <strong>{shifts.length}</strong> shifts.
          </p>
          <div style={{ overflowX: "auto", maxHeight: 500, overflowY: "auto" }}>
            <table
              border={1}
              cellPadding={4}
              style={{ borderCollapse: "collapse", minWidth: 700 }}
            >
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Shift</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Doctor (guessed)</th>
                  <th>Raw cell text</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s, i) => (
                  <tr key={i}>
                    <td>{s.date}</td>
                    <td>{s.shiftName}</td>
                    <td>{s.startTime}</td>
                    <td>{s.endTime}</td>
                    <td>{s.doctor}</td>
                    <td>
                      <pre
                        style={{
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          fontSize: "0.75rem",
                        }}
                      >
                        {s.rawCell}
                      </pre>
                    </td>
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
