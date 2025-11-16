"use client";

import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

// ---------- Types ----------

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

type Contact = {
  email: string;
  phone: string;
  preferred: "email" | "sms" | "either" | "none";
};

type ShiftGroup = {
  date: string;
  shifts: Shift[];
};

const TF_CONTACT_STORAGE_KEY = "metriManagerTradeFishingContact";

// ---------- Helpers: dates / parsing ----------

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

// ---------- Contact helpers ----------

function formatPreference(contact?: Contact): string {
  if (!contact) return "No contact info";
  switch (contact.preferred) {
    case "email":
      return "Prefers email";
    case "sms":
      return "Prefers SMS";
    case "either":
      return "Email or SMS";
    case "none":
      if (!contact.email && !contact.phone) return "Prefers not to share";
      return "Prefers not to share";
    default:
      return "No preference set";
  }
}

// ---------- Component ----------

export default function MarketplaceXlsxPage() {
  // Doctor list from /api/schedule (like Same-Day mode)
  const [doctorList, setDoctorList] = useState<string[]>([]);
  const [doctorLoadError, setDoctorLoadError] = useState<string | null>(null);
  const [selectedDoctor, setSelectedDoctor] = useState("");

  // Trade Fishing contact info (local only)
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  // XLSX parsing state
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ----- Load doctor list from /api/schedule -----
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
          "Could not load doctor list from the schedule. You can still upload a file and use the parser."
        );
      }
    }

    loadDoctors();
  }, []);

  // ----- Load saved Trade Fishing contact from localStorage -----
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(TF_CONTACT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Contact;
      setContactDraft(parsed);
    } catch {
      // ignore
    }
  }, []);

  // ----- Save contact info locally -----
  const handleSaveContact = () => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          TF_CONTACT_STORAGE_KEY,
          JSON.stringify(contactDraft)
        );
      }
      setContactSavedMessage("Contact information saved on this device.");
    } catch {
      setContactSavedMessage(
        "There was a problem saving contact info locally."
      );
    }
    setTimeout(() => setContactSavedMessage(""), 3000);
  };

  const myPreferenceText = formatPreference(contactDraft);

  // ----- XLSX file handling -----
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

  // ----- Derive: future-only, sorted & grouped by date -----
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

    return Array.from(map.entries()).map(([date, groupShifts]) => ({
      date,
      shifts: groupShifts,
    }));
  }, [shifts]);

  const totalFuture = groupedFutureShifts.reduce(
    (sum, g) => sum + g.shifts.length,
    0
  );

  // ---------- Render ----------

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Metri-Manager – Trade Fishing (Marketplace XLSX)</h1>
      <p style={{ marginBottom: "1rem" }}>
        Upload a MetricAid <code>.xlsx</code> export (the one that includes your
        own schedule + marketplace). This prototype parses the shifts and shows{" "}
        <strong>future days</strong> grouped by date. The next step will be the
        actual &quot;find good trades&quot; logic.
      </p>

      {/* ---- 1. Pick your name (Same-Day style) ---- */}
      <section
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          borderRadius: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        <h2>1. Pick your name</h2>
        <p>
          For now this is mainly to keep the UI consistent with Same-Day
          Trades. Later Trade Fishing logic will use your name to avoid
          suggesting trades with yourself.
        </p>

        {doctorLoadError && (
          <p style={{ color: "red" }}>{doctorLoadError}</p>
        )}

        <h3>Pick your name from the schedule</h3>
        {doctorList.length === 0 && !doctorLoadError && <p>Loading…</p>}
        {doctorList.length > 0 && (
          <select
            value={selectedDoctor}
            onChange={(e) => setSelectedDoctor(e.target.value)}
            style={{ width: "100%", padding: "0.5rem", maxWidth: 400 }}
          >
            <option value="">-- Choose your name --</option>
            {doctorList.map((doc) => (
              <option key={doc} value={doc}>
                {doc}
              </option>
            ))}
          </select>
        )}
      </section>

      {/* ---- 2. Contact registration (Same-Day style, local only) ---- */}
      <section
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          borderRadius: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        <h2>2. Optional contact info (Trade Fishing)</h2>
        <p style={{ fontSize: "0.9rem", color: "#555" }}>
          This looks like the Same-Day contact block, but right now it only
          saves to <strong>this device</strong> for Trade Fishing use. We are
          not yet syncing this with the shared contacts table.
        </p>

        <p>
          You are editing contact info for:{" "}
          <strong>
            {selectedDoctor ? `Dr. ${selectedDoctor}` : "no doctor selected"}
          </strong>
        </p><section
  style={{
    border: "1px solid #ccc",
    padding: "1rem",
    borderRadius: "0.5rem",
    marginBottom: "1rem",
  }}
>
  <h2>2. Optional contact info (Trade Fishing)</h2>

  {!selectedDoctor && (
    <p style={{ fontSize: "0.9rem", color: "#555" }}>
      Pick your name in step 1 first. Once you&apos;ve chosen your name,
      you&apos;ll be able to save optional email / phone details for Trade
      Fishing.
    </p>
  )}

  {selectedDoctor && (
    <>
      <p style={{ fontSize: "0.9rem", color: "#555" }}>
        This looks like the Same-Day contact block, but right now it only
        saves to <strong>this device</strong> for Trade Fishing use. We are
        not yet syncing this with the shared contacts table.
      </p>

      <p>
        You are editing contact info for:{" "}
        <strong>Dr. {selectedDoctor}</strong>
      </p>
      <p style={{ fontSize: "0.9rem", color: "#555" }}>
        Your current preference: <strong>{myPreferenceText}</strong>
      </p>

      <div style={{ marginBottom: "0.5rem" }}>
        <label>
          Email:&nbsp;
          <input
            type="email"
            value={contactDraft.email}
            onChange={(e) =>
              setContactDraft((c) => ({
                ...c,
                email: e.target.value,
              }))
            }
            style={{ width: "100%", maxWidth: 400 }}
            placeholder="you@example.com"
          />
        </label>
      </div>
      <div style={{ marginBottom: "0.5rem" }}>
        <label>
          Phone (optional):&nbsp;
          <input
            type="tel"
            value={contactDraft.phone}
            onChange={(e) =>
              setContactDraft((c) => ({
                ...c,
                phone: e.target.value,
              }))
            }
            style={{ width: "100%", maxWidth: 400 }}
            placeholder="+1-204-555-1234"
          />
        </label>
      </div>
      <div style={{ marginBottom: "0.5rem" }}>
        <span>Preferred notification method:&nbsp;</span>
        <label>
          <input
            type="radio"
            name="tfPreferred"
            value="email"
            checked={contactDraft.preferred === "email"}
            onChange={() =>
              setContactDraft((c) => ({
                ...c,
                preferred: "email",
              }))
            }
          />
          &nbsp;Email
        </label>
        &nbsp;&nbsp;
        <label>
          <input
            type="radio"
            name="tfPreferred"
            value="sms"
            checked={contactDraft.preferred === "sms"}
            onChange={() =>
              setContactDraft((c) => ({
                ...c,
                preferred: "sms",
              }))
            }
          />
          &nbsp;SMS
        </label>
        &nbsp;&nbsp;
        <label>
          <input
            type="radio"
            name="tfPreferred"
            value="either"
            checked={contactDraft.preferred === "either"}
            onChange={() =>
              setContactDraft((c) => ({
                ...c,
                preferred: "either",
              }))
            }
          />
          &nbsp;Either
        </label>
        &nbsp;&nbsp;
        <label>
          <input
            type="radio"
            name="tfPreferred"
            value="none"
            checked={contactDraft.preferred === "none"}
            onChange={() =>
              setContactDraft((c) => ({
                ...c,
                preferred: "none",
              }))
            }
          />
          &nbsp;I prefer not to share
        </label>
      </div>
      <button
        type="button"
        onClick={handleSaveContact}
        style={{
          padding: "0.4rem 0.8rem",
          marginBottom: "0.5rem",
        }}
      >
        Save contact info
      </button>
      {contactSavedMessage && (
        <div
          style={{
            color: "green",
            marginBottom: "0.5rem",
          }}
        >
          {contactSavedMessage}
        </div>
      )}
      <p style={{ fontSize: "0.9rem", color: "#555" }}>
        By entering my email and/or phone number and clicking Save, I consent
        to this site storing my contact information{" "}
        <strong>on this device</strong> so I can use it while fishing for
        trades.
      </p>
    </>
  )}
</section>

      {/* ---- 3. Upload XLSX ---- */}
      <section
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          borderRadius: "0.5rem",
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

      {/* ---- Parsed output ---- */}
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
