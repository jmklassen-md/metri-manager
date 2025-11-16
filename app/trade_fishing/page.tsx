"use client";

import React, { useEffect, useState } from "react";
import * as XLSX from "xlsx";

/* ------------------------------------------------
   Shared types
------------------------------------------------ */

type Shift = {
  date: string;      // "2025-11-17"
  shiftName: string; // "R5", "Surge-AM", etc.
  startTime: string; // "05:00"
  endTime: string;   // "09:00"
  doctor: string;    // e.g. "Klassen"
  rawCell: string;   // original text for debugging
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

const CONTACTS_STORAGE_KEY = "metriManagerContacts";

/* ------------------------------------------------
   Small helpers
------------------------------------------------ */

function isDateHeader(value: string): boolean {
  // e.g. "Mon, Nov 17"
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value.trim());
}

function normalizeDate(header: string, fallbackYear?: number): string | null {
  // "Mon, Nov 17" -> "YYYY-11-17"
  const parts = header.replace(",", "").split(/\s+/); // ["Mon","Nov","17"]
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

function extractDoctorName(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "--") return "";
  const match = trimmed.match(/[A-Za-z]+/);
  return match ? match[0] : trimmed;
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

function formatHumanDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/* ------------------------------------------------
   XLSX parser (same logic as marketplace_xlsx page)
------------------------------------------------ */

function parseMarketplaceXlsx(arrayBuffer: ArrayBuffer): Shift[] {
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const ref = sheet["!ref"];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);

  // Active date per column
  const datesByCol: (string | null)[] = new Array(range.e.c + 1).fill(null);
  const shifts: Shift[] = [];

  // Guess year from first header we see
  let detectedYear: number | undefined;

  for (let r = range.s.r; r <= range.e.r; r++) {
    // Pass 1: update date headers
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
        if (normalized) datesByCol[c] = normalized;
      }
    }

    // Pass 2: find shift cells
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddr];
      const value = typeof cell?.v === "string" ? cell.v : "";
      if (!value) continue;

      const activeDate = datesByCol[c];
      if (!activeDate) continue;

      const lines = value.split(/\r?\n/);
      const lastLine = lines[lines.length - 1].trim();

      const m = lastLine.match(
        /^(.+?)\s*-\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/
      );
      if (!m) continue;

      const shiftName = m[1].trim();
      const startTime = m[2].padStart(5, "0");
      const endTime = m[3].padStart(5, "0");

      // Name row is next row down in same column
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

/* ------------------------------------------------
   Page component
------------------------------------------------ */

export default function TradeFishingPage() {
  const [yourName, setYourName] = useState(""); // who are you?
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* ---------- Load contacts (DB + localStorage fallback) ---------- */

  useEffect(() => {
    async function loadContacts() {
      try {
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
        // API failed – local storage only
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

  // Persist contacts to localStorage whenever they change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const toStore = JSON.stringify(contacts);
      window.localStorage.setItem(CONTACTS_STORAGE_KEY, toStore);
    } catch {
      // ignore
    }
  }, [contacts]);

  /* ---------- When yourName changes, hydrate contactDraft ---------- */

  useEffect(() => {
    setContactSavedMessage("");
    if (!yourName.trim()) {
      setContactDraft({ email: "", phone: "", preferred: "none" });
      return;
    }
    const existing = contacts[yourName.trim()];
    setContactDraft({
      email: existing?.email || "",
      phone: existing?.phone || "",
      preferred: existing?.preferred || "none",
    });
  }, [yourName, contacts]);

  const myContact: Contact | undefined =
    yourName && contacts[yourName] ? contacts[yourName] : undefined;
  const myPreferenceText = myContact
    ? formatPreference(myContact)
    : "No contact info saved for you yet.";

  /* ---------- Save contact info ---------- */

  const handleSaveContact = async () => {
    const name = yourName.trim();
    if (!name) return;

    const payload: Contact = {
      email: contactDraft.email.trim(),
      phone: contactDraft.phone.trim(),
      preferred: contactDraft.preferred,
    };

    setContacts((prev) => ({
      ...prev,
      [name]: payload,
    }));

    try {
      await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          doctorName: name,
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

  /* ---------- XLSX upload ---------- */

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
    } catch (err) {
      console.error(err);
      setError("Failed to read XLSX – check console for details.");
    } finally {
      setLoading(false);
    }
  };

  /* ---------- Render ---------- */

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Metri-Manager – Trade Fishing (Prototype)</h1>
      <p style={{ marginBottom: "1rem" }}>
        Upload a MetricAid marketplace <code>.xlsx</code> export. I&apos;ll
        parse all marketplace shifts below. In a later step, we&apos;ll add the
        &quot;find good trades&quot; engine on top of this.
      </p>

      {/* Who are you? */}
      <section
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          borderRadius: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        <h2>1. Identify yourself</h2>
        <p>
          Enter your name <em>exactly</em> as it appears in MetricAid (e.g.{" "}
          <code>Klassen</code>). This lets Trade Fishing match marketplace
          shifts to your contact info.
        </p>
        <input
          type="text"
          value={yourName}
          onChange={(e) => setYourName(e.target.value)}
          placeholder="Your last name (e.g. Klassen)"
          style={{ width: "100%", maxWidth: 400, padding: "0.5rem" }}
        />

        {yourName.trim() && (
          <>
            <hr style={{ margin: "1rem 0" }} />
            <h3>Contact registration for Metri-Manager</h3>
            {!contactsLoaded && <p>Loading contact preferences…</p>}
            {contactsLoaded && (
              <>
                <p>
                  You are editing contact info for:{" "}
                  <strong>Dr. {yourName.trim()}</strong>
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
                      name="preferred"
                      value="email"
                      checked={contactDraft.preferred === "email"}
                      onChange={() =>
                        setContactDraft((c) => ({ ...c, preferred: "email" }))
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
                        setContactDraft((c) => ({ ...c, preferred: "sms" }))
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
                        setContactDraft((c) => ({ ...c, preferred: "either" }))
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
                        setContactDraft((c) => ({ ...c, preferred: "none" }))
                      }
                    />
                    &nbsp;I prefer not to share
                  </label>
                </div>

                <button
                  type="button"
                  onClick={handleSaveContact}
                  style={{ padding: "0.4rem 0.8rem", marginBottom: "0.5rem" }}
                >
                  Save contact info
                </button>
                {contactSavedMessage && (
                  <div style={{ color: "green", marginBottom: "0.5rem" }}>
                    {contactSavedMessage}
                  </div>
                )}
                <p style={{ fontSize: "0.9rem", color: "#555" }}>
                  By entering my email and/or phone number and clicking Save, I
                  consent to this site storing my contact information so that
                  other users can contact me for shift trades.
                </p>
              </>
            )}
          </>
        )}
      </section>

      {/* XLSX upload + parsed view */}
      <section
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          borderRadius: "0.5rem",
        }}
      >
        <h2>2. Upload marketplace spreadsheet</h2>
        <p>
          Choose the MetricAid <code>.xlsx</code> export that includes your own
          shifts plus marketplace shifts.
        </p>
        <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />

        {loading && <p>Reading and parsing XLSX…</p>}
        {error && <p style={{ color: "red" }}>{error}</p>}

        {shifts.length > 0 && (
          <>
            <p style={{ marginTop: "1rem" }}>
              Parsed <strong>{shifts.length}</strong> shifts from this file.
            </p>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
              This is just a sanity-check table for now. Next step will be to
              filter these into smart Trade Fishing suggestions based on your
              own schedule and turnaround rules.
            </p>
            <div
              style={{
                overflowX: "auto",
                maxHeight: 500,
                overflowY: "auto",
                marginTop: "0.5rem",
              }}
            >
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
                    <th>Doctor</th>
                    <th>Raw cell text</th>
                  </tr>
                </thead>
                <tbody>
                  {shifts.map((s, i) => (
                    <tr key={i}>
                      <td>{formatHumanDate(s.date)}</td>
                      <td>{s.shiftName}</td>
                      <td>{s.startTime}</td>
                      <td>{s.endTime}</td>
                      <td>{s.doctor || "UNKNOWN"}</td>
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
      </section>
    </main>
  );
}
