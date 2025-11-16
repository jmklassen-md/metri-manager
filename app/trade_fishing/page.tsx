"use client";

import React, { useState } from "react";
import * as XLSX from "xlsx";

type MarketplaceShift = {
  date: string;      // "2025-11-17"
  shiftName: string; // "R22", "R5", "RAZ-N", etc.
  startTime: string; // "22:00"
  endTime: string;   // "02:00"
  doctor: string;    // "Klassen"
};

// TODO: replace this with the same parsing logic we use on /marketplace_xlsx
function dummyParseWorkbook(file: File): Promise<MarketplaceShift[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });

        // For now: just dump the first sheet as a single fake shift
        // so we can prove the wiring works.
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json<any>(sheet, { header: 1 });

        // VERY dumb example: look for any row that has something that looks like "R5 - 05:00-09:00"
        const shifts: MarketplaceShift[] = [];
        for (const row of json) {
          if (!Array.isArray(row)) continue;
          for (const cell of row) {
            if (typeof cell !== "string") continue;
            const m = cell.match(
              /(R[A-Z0-9\-]+)\s*-\s*([0-9]{2}:[0-9]{2})-([0-9]{2}:[0-9]{2})/
            );
            if (m) {
              shifts.push({
                date: "2025-11-17", // placeholder – we will wire real dates from your debug parser
                shiftName: m[1],
                startTime: m[2],
                endTime: m[3],
                doctor: "UNKNOWN",
              });
            }
          }
        }

        resolve(shifts);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
}

export default function TradeFishingPage() {
  const [shifts, setShifts] = useState<MarketplaceShift[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setLoading(true);
    setShifts([]);

    try {
      const parsed = await dummyParseWorkbook(file);
      setShifts(parsed);
    } catch (err) {
      console.error(err);
      setError("Failed to parse XLSX – see console.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "1rem" }}>
      <h1>Trade Fishing</h1>
      <p style={{ marginBottom: "1rem" }}>
        Upload a MetricAid marketplace .xlsx file. I&apos;ll parse all
        marketplace shifts and show them below.
      </p>

      <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />

      {loading && <p>Parsing…</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {shifts.length > 0 && (
        <>
          <h2 style={{ marginTop: "1.5rem" }}>Parsed marketplace shifts</h2>
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            (This is just a sanity-check table – we&apos;ll later add the
            &quot;find good trades&quot; logic.)
          </p>
          <div style={{ overflowX: "auto" }}>
            <table
              border={1}
              cellPadding={4}
              style={{ borderCollapse: "collapse", minWidth: 600 }}
            >
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Shift</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Doctor</th>
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
