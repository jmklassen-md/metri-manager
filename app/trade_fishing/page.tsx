"use client";

import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

type Shift = {
  date: string;       // "2025-11-17"
  shiftName: string;  // "R5", "Surge-AM", etc.
  startTime: string;  // "05:00"
  endTime: string;    // "09:00"
  doctor: string;     // e.g. "Klassen"
  rawCell: string;    // original text for debugging
};

type ApiShift = {
  date: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  doctor: string;
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
      const doctor = extractDoctorName(docText) || "UNKNOWN";

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

type ShiftGroup = {
  date: string;
  shifts: Shift[];
};

export default function MarketplaceXlsxPage() {
  // ---- identity + contact state ----
  const [doctorList, setDoctorList] = useState<string[]>([]);
  const [doctorLoadError, setDoctorLoadError] = useState<string | null>(null);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [manualDoctor, setManualDoctor] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const effectiveDoctorName = (selectedDoctor || manualDoctor).trim();

  // Load doctor list from /api/schedule (same source as Same-Day mode)
  useEffect(() => {
    async function loadDoctors() {
      try {
        const res = await fetch("/api/schedule");
        if (!res.ok) throw new Error("Failed to fetch schedule");
        const data = (await res.json()) as ApiShift[];
        if (!Array.isArray(data)) throw new Error("Schedule not in array form");

        const docs = Array.from(
          new Set(
            data
              .map((s) => (s.doctor || "").trim())
              .filter((n) => n.length > 0)
          )
        ).sort((a, b) => a.localeCompare(b));

        setDoctorList(docs);
      } catch (err) {
        console.error(err);
        setDoctorLoadError(
          "Could not load doctor list from the schedule. You can still type your name manually."
        );
      }
    }

    loadDoctors();
  }, []);

  // ---- XLSX parsing state ----
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

  // ---- derive: future-only, sorted & grouped by date ----
  const groupedFutureShifts: ShiftGroup[] = useMemo(() => {
    if (!shifts.length) return [];

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const future = shifts.filter((s) => s.date >= today);

    const sorted = [...future].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.startTime !== b.startTime)
        return a.startTime.localeCompare(b.startTime);
      return a.shiftName.localeCompare(b.shiftName);
    });

    const map = new Map<string, Shift[]>();
    for (const s of sorted) {
      if (!map.has(s.date)) map.set(s.date, []);
      map.get(s.date)!.push(s);
    }

    return Array.from(map.entries()).map(([date, shifts]) => ({
      date,
      shifts,
    }));
  }, [shifts]);

  const totalFuture = groupedFutureShifts.reduce(
    (sum, g) => sum + g.shifts.length,
    0
  );

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Metri-Manager – Trade Fishing (Prototype)</h1>
      <p>
        Upload a MetricAid{" "}
        <code>.xlsx</code> export (the one that includes your own schedule +
        marketplace). This prototype parses the marketplace shifts, showing{" "}
        <strong>future</strong> shifts grouped by date. Next step will be the
        actual &quot;find good trades&quot; logic.
      </p>

      {/* 1. Pick your name */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <h2>1. Pick your name</h2>

        {doctorLoadError && (
          <p style={{ color: "red", marginBottom: "0.5rem" }}>
            {doctorLoadError}
          </p>
        )}

        {doctorList.length > 0 && (
          <div style={{ marginBottom: "0.75rem" }}>
            <label style={{ display: "block", marginBottom: "0.25rem" }}>
              Choose from schedule list:
            </label>
            <select
              value={selectedDoctor}
              onChange={(e) => setSelectedDoctor(e.target.value)}
              style={{ width: "100%", maxWidth: 400, padding: "0.4rem" }}
            >
              <option value="">-- Select your name --</option>
              {doctorList.map((doc) => (
                <option key={doc} value={doc}>
                  {doc}
                </option>
              ))}
            </select>
          </div>
        )}

        <div style={{ marginBottom: "0.75rem" }}>
          <label style={{ display: "block", marginBottom: "0.25rem" }}>
            Or type your last name:
          </label>
          <input
            type="text"
            value={manualDoctor}
            onChange={(e) => setManualDoctor(e.target.value)}
            placeholder="Your last name (e.g. Klassen)"
            style={{ width: "100%", maxWidth: 400, padding: "0.4rem" }}
          />
        </div>

        <p style={{ fontSize: "0.85rem", color: "#555" }}>
          Current name:{" "}
          <strong>{effectiveDoctorName || "(none selected yet)"}</strong>
        </p>
      </section>

      {/* 2. Optional contact info */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <h2>2. Optional contact info</h2>
        <p style={{ fontSize: "0.9rem", color: "#555" }}>
          This is just for your own reference while you&apos;re fishing for
          trades (for example, to copy-paste into emails or texts). We&apos;re
          not yet saving this to the shared contacts list.
        </p>
        <div style={{ marginBottom: "0.5rem" }}>
          <label style={{ display: "block", marginBottom: "0.25rem" }}>
            Email:
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={{ width: "100%", maxWidth: 400, padding: "0.4rem" }}
          />
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label style={{ display: "block", marginBottom: "0.25rem" }}>
            Phone:
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1-204-555-1234"
            style={{ width: "100%", maxWidth: 400, padding: "0.4rem" }}
          />
        </div>
      </section>

      {/* 3. Upload XLSX */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <h2>3. Upload marketplace spreadsheet</h2>
        <p style={{ marginBottom: "0.75rem" }}>
          Choose the MetricAid <code>.xlsx</code> export that includes your own
          shifts plus marketplace shifts.
        </p>

        <div style={{ margin: "0.5rem 0 1rem" }}>
          <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />
        </div>

        {loading && <p>Reading and parsing XLSX…</p>}
        {error && <p style={{ color: "red" }}>{error}</p>}
      </section>

      {/* Parsed output */}
      {groupedFutureShifts.length > 0 && (
        <>
          <p>
            Parsed <strong>{totalFuture}</strong> future shift
            {totalFuture === 1 ? "" : "s"} on{" "}
            <strong>{groupedFutureShifts.length}</strong> date
            {groupedFutureShifts.length === 1 ? "" : "s"}.
          </p>

          {groupedFutureShifts.map((group) => (
            <section
              key={group.date}
              style={{
                marginTop: "1rem",
                paddingTop: "0.75rem",
                borderTop: "1px solid #ddd",
              }}
            >
              <h2 style={{ marginBottom: "0.4rem" }}>{group.date}</h2>
              <div style={{ overflowX: "auto", maxHeight: 400 }}>
                <table
                  border={1}
                  cellPadding={4}
                  style={{ borderCollapse: "collapse", minWidth: 700 }}
                >
                  <thead>
                    <tr>
                      <th>Shift</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Doctor (guessed)</th>
                      <th>Raw cell text</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.shifts.map((s, i) => (
                      <tr key={i}>
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
            </section>
          ))}
        </>
      )}

      {!loading && !error && shifts.length > 0 && totalFuture === 0 && (
        <p>
          Parsed {shifts.length} shifts, but none are on dates after today, so
          there&apos;s nothing in the future to show.
        </p>
      )}
    </main>
  );
}
