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

type Contact = {
  email: string;
  phone: string;
  preferred: "email" | "sms" | "either" | "none";
};

const TRADEFISH_CONTACTS_STORAGE_KEY = "metriManagerTradeFishingContacts";

// ---------- Small helpers ----------

/** Detect cells like "Mon, Nov 17" */
function isDateHeader(value: string): boolean {
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value.trim());
}

/** Convert "Mon, Nov 17" to "2025-11-17" (or whatever year we guess) */
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
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
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

function formatHumanDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

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

  // Name selection (like Same-Day mode)
  const [selectedDoctor, setSelectedDoctor] = useState("");

  // Local-only Trade Fishing contacts (per doctor, stored in localStorage on this device)
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  // ---------- Load/save contacts locally (on this device) ----------

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(TRADEFISH_CONTACTS_STORAGE_KEY);
      const stored = raw ? (JSON.parse(raw) as Record<string, Contact>) : {};
      setContacts(stored);
    } catch {
      setContacts({});
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        TRADEFISH_CONTACTS_STORAGE_KEY,
        JSON.stringify(contacts)
      );
    } catch {
      // ignore
    }
  }, [contacts]);

  // When doctor changes, populate the draft from existing contact or blank
  useEffect(() => {
    setContactSavedMessage("");
    if (!selectedDoctor) {
      setContactDraft({ email: "", phone: "", preferred: "none" });
      return;
    }
    const existing = contacts[selectedDoctor];
    setContactDraft({
      email: existing?.email || "",
      phone: existing?.phone || "",
      preferred: existing?.preferred || "none",
    });
  }, [selectedDoctor, contacts]);

  const myContact: Contact | undefined =
    selectedDoctor && contacts[selectedDoctor]
      ? contacts[selectedDoctor]
      : undefined;

  const myPreferenceText = myContact
    ? formatPreference(myContact)
    : "No contact info saved for you yet.";

  const handleSaveContact = () => {
    if (!selectedDoctor) return;
    const payload: Contact = {
      email: contactDraft.email.trim(),
      phone: contactDraft.phone.trim(),
      preferred: contactDraft.preferred,
    };
    setContacts((prev) => ({
      ...prev,
      [selectedDoctor]: payload,
    }));
    setContactSavedMessage("Contact information saved on this device.");
    setTimeout(() => setContactSavedMessage(""), 3000);
  };

  // ---------- File upload & parse ----------

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

  // ---------- Doctors list (from parsed shifts) ----------

  const doctors = useMemo(
    () =>
      Array.from(
        new Set(
          shifts
            .map((s) => (s.doctor || "").trim())
            .filter((n) => n.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [shifts]
  );

  // ---------- Shifts grouped by future date ----------

  const groupedFutureShifts = useMemo(() => {
    if (shifts.length === 0) return [];

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10); // YYYY-MM-DD

    const byDate: Record<string, Shift[]> = {};

    for (const s of shifts) {
      if (!s.date) continue;
      // keep only future (or today) dates
      if (s.date < todayStr) continue;

      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    }

    const dates = Object.keys(byDate).sort((a, b) => a.localeCompare(b));

    return dates.map((date) => {
      const list = [...byDate[date]];
      list.sort((a, b) =>
        `${a.startTime} ${a.shiftName}`.localeCompare(
          `${b.startTime} ${b.shiftName}`
        )
      );
      return { date, shifts: list };
    });
  }, [shifts]);

  // ---------- Render ----------

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Marketplace XLSX Parser (Prototype)</h1>
      <p>
        Upload a MetricAid <code>.xlsx</code> export (the one that includes your
        own schedule + marketplace). This tool will try to pull out individual
        shifts: date, shift name, times, and primary doctor, then list future
        shifts grouped by date.
      </p>

      <div style={{ margin: "1rem 0" }}>
        <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />
      </div>

      {loading && <p>Reading and parsing XLSX…</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}

      {shifts.length > 0 && (
        <>
          <p>
            Parsed <strong>{shifts.length}</strong> shifts total.
          </p>

          {/* 1. Pick your name (like Same-Day mode) */}
          <section
            style={{
              border: "1px solid #ccc",
              padding: "1rem",
              borderRadius: "0.5rem",
              marginBottom: "1rem",
            }}
          >
            <h2>1. Pick your name</h2>
            <p style={{ marginBottom: "0.5rem" }}>
              Choose your name so Trade Fishing can remember your contact
              details on this device.
            </p>

            {doctors.length === 0 && (
              <p style={{ fontStyle: "italic" }}>
                No doctor names detected yet from this file.
              </p>
            )}

            {doctors.length > 0 && (
              <select
                value={selectedDoctor}
                onChange={(e) => setSelectedDoctor(e.target.value)}
                style={{ width: "100%", padding: "0.5rem" }}
              >
                <option value="">-- Choose your name --</option>
                {doctors.map((doc) => (
                  <option key={doc} value={doc}>
                    {doc}
                  </option>
                ))}
              </select>
            )}
          </section>

          {/* 2. Optional contact info – appears only after you choose your name */}
          <section
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
                Pick your name in step 1 first. Once you&apos;ve chosen your
                name, you&apos;ll be able to save optional email / phone details
                for future Trade Fishing features.
              </p>
            )}

            {selectedDoctor && (
              <>
                <p style={{ fontSize: "0.9rem", color: "#555" }}>
                  This looks like the Same-Day contact block, but right now it
                  only saves to <strong>this device</strong> for Trade Fishing
                  use. It is <strong>not yet</strong> synced with the shared
                  contacts table.
                </p>

                <p>
                  You are editing contact info for:{" "}
                  <strong>Dr. {selectedDoctor}</strong>
                </p>
                <p style={{ fontSize: "0.9rem", color: "#555" }}>
                  Your current preference:{" "}
                  <strong>{myPreferenceText}</strong>
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
                  By entering my email and/or phone number and clicking Save, I
                  consent to this site storing my contact information{" "}
                  <strong>on this device</strong> so I can use it while fishing
                  for trades.
                </p>
              </>
            )}
          </section>

          {/* 3. Parsed future shifts grouped by date */}
          <section
            style={{
              border: "1px solid #ccc",
              padding: "1rem",
              borderRadius: "0.5rem",
            }}
          >
            <h2>3. Parsed future shifts (grouped by date)</h2>

            {groupedFutureShifts.length === 0 && (
              <p>No future shifts found in this file.</p>
            )}

            {groupedFutureShifts.map((group) => (
              <div
                key={group.date}
                style={{
                  borderTop: "1px solid #eee",
                  paddingTop: "0.5rem",
                  marginTop: "0.5rem",
                }}
              >
                <strong>{formatHumanDate(group.date)}</strong>
                <div style={{ overflowX: "auto", marginTop: "0.25rem" }}>
                  <table
                    border={1}
                    cellPadding={4}
                    style={{
                      borderCollapse: "collapse",
                      minWidth: 700,
                      fontSize: "0.9rem",
                    }}
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
                                fontSize: "0.7rem",
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
              </div>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
