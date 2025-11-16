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

type Contact = {
  email: string;
  phone: string;
  preferred: "email" | "sms" | "either" | "none";
};

type ContactApiRow = {
  doctorName: string;
  email: string | null;
  phone: string | null;
  preferred: string | null;
};

type GroupedDay = {
  date: string;
  shifts: Shift[];
};

const CONTACTS_STORAGE_KEY = "metriManagerContacts";

// ---------- Helpers ----------

/** Detect cells like "Mon, Nov 17" */
function isDateHeader(value: string): boolean {
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value.trim());
}

/** Convert "Mon, Nov 17" to "YYYY-MM-DD" (using a best-guess year) */
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
  // Grab the first run of letters as the doc's last name.
  const match = trimmed.match(/[A-Za-z]+/);
  return match ? match[0] : trimmed;
}

/** Nice human-readable date (Mon, Nov 17, 2025, etc.) */
function formatHumanDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Contact preference display */
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

/** Parse the MetricAid XLSX export into a list of shifts */
function parseMarketplaceXlsx(arrayBuffer: ArrayBuffer): Shift[] {
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const ref = sheet["!ref"];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);

  // Keep track of the active date for each column (seven day-columns per week)
  const datesByCol: (string | null)[] = new Array(range.e.c + 1).fill(null);

  const shifts: Shift[] = [];

  // Try to detect year from the first date header we see
  let detectedYear: number | undefined;

  for (let r = range.s.r; r <= range.e.r; r++) {
    // Pass 1: detect/set any date headers in this row
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddr];
      const v = typeof cell?.v === "string" ? cell.v.trim() : "";
      if (!v) continue;

      if (isDateHeader(v)) {
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

    // Pass 2: look for shift cells in this row (location + shift + times)
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddr];
      const value = typeof cell?.v === "string" ? cell.v : "";
      if (!value) continue;

      const activeDate = datesByCol[c];
      if (!activeDate) continue; // we don't know which day this column belongs to

      // Typically last line of the cell is like "R22 - 22:00-02:00"
      const lines = value.split(/\r?\n/);
      const lastLine = lines[lines.length - 1].trim();

      const m = lastLine.match(
        /^(.+?)\s*-\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/
      );
      if (!m) continue;

      const shiftName = m[1].trim();
      const startTime = m[2].padStart(5, "0");
      const endTime = m[3].padStart(5, "0");

      // Look at the *next* row in same column for the doctor name
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

// ---------- Component ----------

export default function TradeFishingPage() {
  // From ICS: schedule + doctor names
  const [scheduleShifts, setScheduleShifts] = useState<Shift[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Contacts (DB + localStorage)
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [contactsLoaded, setContactsLoaded] = useState(false);

  // User identity for Trade Fishing
  const [selectedDoctor, setSelectedDoctor] = useState("");

  // Contact editor state (Same-Day style)
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  // Marketplace XLSX
  const [marketplaceShifts, setMarketplaceShifts] = useState<Shift[]>([]);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const [xlsxLoading, setXlsxLoading] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState("");

  // ---------- Load schedule (for doctor list) ----------

  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) {
          setScheduleError("Could not load schedule.");
          return;
        }
        // We only need doctor + date-ish info; but we keep everything in case we
        // want to cross-reference later.
        const mapped: Shift[] = data.map((s: any) => ({
          date: s.date,
          shiftName: s.shiftName,
          startTime: s.startTime,
          endTime: s.endTime,
          doctor: s.doctor,
          rawCell: s.raw ?? "",
        }));
        setScheduleShifts(mapped);
      })
      .catch(() => setScheduleError("Could not load schedule."));
  }, []);

  // ---------- Doctors from ICS ----------

  const doctorsFromSchedule = useMemo(
    () =>
      Array.from(
        new Set(
          scheduleShifts
            .map((s) => (s.doctor || "").trim())
            .filter((n) => n.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [scheduleShifts]
  );

  // ---------- Load contacts (DB + localStorage) ----------

  useEffect(() => {
    async function loadContacts() {
      try {
        // 1) From API / Postgres
        const res = await fetch("/api/contacts");
        if (!res.ok) throw new Error("Failed to fetch contacts");
        const rows = (await res.json()) as ContactApiRow[];

        const fromDb: Record<string, Contact> = {};
        for (const row of rows) {
          fromDb[row.doctorName] = {
            email: row.email || "",
            phone: row.phone || "",
            preferred: (row.preferred as Contact["preferred"]) ?? "none",
          };
        }

        // 2) Merge with localStorage
        let fromLocal: Record<string, Contact> = {};
        try {
          const raw =
            typeof window !== "undefined"
              ? window.localStorage.getItem(CONTACTS_STORAGE_KEY)
              : null;
          fromLocal = raw ? (JSON.parse(raw) as Record<string, Contact>) : {};
        } catch {
          fromLocal = {};
        }

        setContacts({ ...fromDb, ...fromLocal });
      } catch {
        // Fallback: only localStorage
        try {
          const raw =
            typeof window !== "undefined"
              ? window.localStorage.getItem(CONTACTS_STORAGE_KEY)
              : null;
          const stored = raw ? (JSON.parse(raw) as Record<string, Contact>) : {};
          setContacts(stored);
        } catch {
          setContacts({});
        }
      } finally {
        setContactsLoaded(true);
      }
    }

    loadContacts();
  }, []);

  // Persist contacts to localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const toStore = JSON.stringify(contacts);
      window.localStorage.setItem(CONTACTS_STORAGE_KEY, toStore);
    } catch {
      // ignore
    }
  }, [contacts]);

  // ---------- Selected doctor -> contactDraft ----------

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

  // ---------- Save contact info (DB + localStorage) ----------

  const handleSaveContact = async () => {
    if (!selectedDoctor) return;

    const payload: Contact = {
      email: contactDraft.email.trim(),
      phone: contactDraft.phone.trim(),
      preferred: contactDraft.preferred,
    };

    // Update local state first
    setContacts((prev) => ({
      ...prev,
      [selectedDoctor]: payload,
    }));

    try {
      await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doctorName: selectedDoctor,
          email: payload.email,
          phone: payload.phone,
          preferred: payload.preferred,
        }),
      });
      setContactSavedMessage("Contact information saved.");
    } catch {
      setContactSavedMessage(
        "Saved locally, but there was an error syncing with the server."
      );
    }

    setTimeout(() => setContactSavedMessage(""), 3000);
  };

  // ---------- XLSX upload & parse ----------

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setXlsxError(null);
    setXlsxLoading(true);
    setMarketplaceShifts([]);
    setUploadedFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseMarketplaceXlsx(buffer);
      setMarketplaceShifts(parsed);
      if (parsed.length === 0) {
        setXlsxError(
          "Parsed 0 shifts from this file. The layout might be different than expected."
        );
      }
    } catch (err: any) {
      console.error(err);
      setXlsxError("Failed to read XLSX – check console for details.");
    } finally {
      setXlsxLoading(false);
    }
  };

  // ---------- Grouped days for display ----------

  const groupedDays: GroupedDay[] = useMemo(() => {
    if (marketplaceShifts.length === 0) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const nameLower = selectedDoctor.trim().toLowerCase();

    const filtered = marketplaceShifts.filter((s) => {
      const d = new Date(s.date + "T00:00:00");
      if (d < today) return false; // future only

      // ignore rows with no doctor – not tradeable
      const docTrimmed = (s.doctor || "").trim();
      if (!docTrimmed) return false;

      if (nameLower) {
        // drop my own shifts
        const docLower = docTrimmed.toLowerCase();
        if (docLower === nameLower) return false;
      }

      return true;
    });

    if (!filtered.length) return [];

    const byDate: Record<string, Shift[]> = {};
    for (const s of filtered) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    }

    const result: GroupedDay[] = Object.entries(byDate).map(
      ([date, shifts]) => ({
        date,
        shifts: shifts.sort((a, b) =>
          (a.startTime || "").localeCompare(b.startTime || "")
        ),
      })
    );

    result.sort((a, b) => a.date.localeCompare(b.date));
    return result;
  }, [marketplaceShifts, selectedDoctor]);

  // ---------- Render ----------

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Trade Fishing (Prototype)</h1>
      <p style={{ marginBottom: "0.75rem" }}>
        This tool helps you scan the <strong>MetricAid marketplace</strong> for
        shifts that might be good trade targets. For now it just parses your
        exported <code>.xlsx</code> and shows future, tradeable shifts by date.
        Later we’ll add “short turnaround” warnings and smarter suggestions.
      </p>

      {scheduleError && (
        <p style={{ color: "red", marginBottom: "0.75rem" }}>
          {scheduleError}
        </p>
      )}

      {/* 1. Pick your name (from ICS) */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>1. Pick your name</h2>
        <p style={{ fontSize: "0.9rem", color: "#555" }}>
          This helps the app <strong>exclude your own shifts</strong> once we
          compare your schedule to the marketplace.
        </p>

        {doctorsFromSchedule.length === 0 && !scheduleError && (
          <p>Loading doctor list from your schedule…</p>
        )}

        {doctorsFromSchedule.length > 0 && (
          <select
            value={selectedDoctor}
            onChange={(e) => setSelectedDoctor(e.target.value)}
            style={{ width: "100%", padding: "0.5rem" }}
          >
            <option value="">-- Choose your name --</option>
            {doctorsFromSchedule.map((doc) => (
              <option key={doc} value={doc}>
                {doc}
              </option>
            ))}
          </select>
        )}

        {/* Contact registration (Same-Day style, text tweaked for Trade Fishing) */}
        {selectedDoctor && (
          <>
            <hr style={{ margin: "1rem 0" }} />
            <h3>Contact registration for Trade Fishing</h3>
            {!contactsLoaded && <p>Loading contact preferences…</p>}
            {contactsLoaded && (
              <>
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
                      name="preferred"
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
                      name="preferred"
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
                      name="preferred"
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
                      name="preferred"
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
                  consent to this site storing my contact information so I can
                  use it while fishing for trades.
                </p>
              </>
            )}
          </>
        )}
      </section>

      {/* 2. Upload XLSX */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>2. Upload your marketplace .xlsx</h2>
        <p style={{ fontSize: "0.9rem", color: "#555" }}>
          Export the <strong>MetricAid marketplace</strong> as{" "}
          <code>.xlsx</code> (with your schedule included) and upload it here.
          The app will parse shifts by date. It’s okay if you upload first and
          pick your name second, but it usually feels smoother to{" "}
          <strong>choose your name first</strong>.
        </p>

        <div style={{ margin: "0.75rem 0" }}>
          <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />
        </div>

        {uploadedFileName && (
          <p style={{ fontSize: "0.85rem", color: "#555" }}>
            File: <code>{uploadedFileName}</code>
          </p>
        )}

        {xlsxLoading && <p>Reading and parsing XLSX…</p>}
        {xlsxError && <p style={{ color: "red" }}>{xlsxError}</p>}
      </section>

      {/* 3. Parsed shifts, grouped by date */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>3. Future tradeable shifts</h2>
        {!marketplaceShifts.length && !xlsxLoading && !xlsxError && (
          <p>Upload a marketplace <code>.xlsx</code> to see results here.</p>
        )}

        {marketplaceShifts.length > 0 && groupedDays.length === 0 && (
          <p>
            Parsed{" "}
            <strong>
              {marketplaceShifts.length.toLocaleString(undefined)}
            </strong>{" "}
            shifts, but none are tradeable in the future after filtering out
            empty names and your own shifts.
          </p>
        )}

        {groupedDays.length > 0 && (
          <>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
              Showing future dates only. Rows with no doctor name and any shifts
              belonging to{" "}
              {selectedDoctor ? `Dr. ${selectedDoctor}` : "you"} have been
              removed.
            </p>
            <div style={{ maxHeight: 500, overflowY: "auto" }}>
              {groupedDays.map((day) => (
                <div
                  key={day.date}
                  style={{
                    borderTop: "1px solid #eee",
                    paddingTop: "0.5rem",
                    marginTop: "0.5rem",
                  }}
                >
                  <strong>{formatHumanDate(day.date)}</strong>
                  <table
                    border={1}
                    cellPadding={4}
                    style={{
                      borderCollapse: "collapse",
                      marginTop: "0.35rem",
                      minWidth: 650,
                    }}
                  >
                    <thead>
                      <tr>
                        <th>Shift</th>
                        <th>Start</th>
                        <th>End</th>
                        <th>Doctor</th>
                        <th style={{ width: "45%" }}>Raw cell text</th>
                      </tr>
                    </thead>
                    <tbody>
                      {day.shifts.map((s, idx) => (
                        <tr key={idx}>
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
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
