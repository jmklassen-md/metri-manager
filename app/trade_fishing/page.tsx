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

type TradeCandidate = {
  candidate: Shift;
  myShort: boolean;
  theirShort: boolean;
};

const CONTACTS_STORAGE_KEY = "metriManagerContacts";

// ---------- Helpers ----------

/** Parse "Mon, Nov 17" style headers */
function isDateHeader(value: string): boolean {
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value.trim());
}

/** Convert "Mon, Nov 17" to "YYYY-MM-DD" (guessing a year if needed) */
function normalizeDate(header: string, fallbackYear?: number): string | null {
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

/** Extract doctor last name-ish from the "names" row */
function extractDoctorName(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "--") return "";

  const match = trimmed.match(/[A-Za-z]+/);
  return match ? match[0] : trimmed;
}

/** Human-readable "Mon, Nov 17, 2025" style */
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

/** Time helpers for shift comparison */

function toDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time || "00:00"}:00`);
}

function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = toDateTime(shift.date, shift.startTime);
  let end = toDateTime(shift.date, shift.endTime);

  // Overnight (e.g. 23:00–09:00, 22:00–02:00)
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return { start, end };
}

function hoursDiff(later: Date, earlier: Date) {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60);
}

function overlapsInterval(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Previous shift end helper (by doctor) */
function findPreviousShiftEnd(
  allShifts: Shift[],
  doctor: string,
  referenceStart: Date,
  ignore: Shift[] = []
): Date | null {
  const ends: Date[] = [];
  for (const s of allShifts) {
    if (ignore.includes(s)) continue;
    if ((s.doctor || "").trim().toLowerCase() !== doctor.trim().toLowerCase())
      continue;
    const { end } = getShiftDateTimes(s);
    if (!isNaN(end.getTime()) && end < referenceStart) {
      ends.push(end);
    }
  }
  if (!ends.length) return null;
  ends.sort((a, b) => b.getTime() - a.getTime());
  return ends[0];
}

/** Parse the MetricAid XLSX export into a list of shifts */
function parseMarketplaceXlsx(arrayBuffer: ArrayBuffer): Shift[] {
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const ref = sheet["!ref"];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);

  // Track active date per column (7 columns = days)
  const datesByCol: (string | null)[] = new Array(range.e.c + 1).fill(null);

  const shifts: Shift[] = [];
  let detectedYear: number | undefined;

  for (let r = range.s.r; r <= range.e.r; r++) {
    // Pass 1: detect date headers
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

    // Pass 2: shift cells
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

      // Name row is next row in same column
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
  // ICS schedule for whole group
  const [scheduleShifts, setScheduleShifts] = useState<Shift[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Contacts
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [contactsLoaded, setContactsLoaded] = useState(false);

  // User identity
  const [selectedDoctor, setSelectedDoctor] = useState("");

  // Contact editing
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  // Which of *my* shifts am I trying to get rid of?
  const [selectedMyShiftIndex, setSelectedMyShiftIndex] = useState("");

  // Marketplace XLSX
  const [marketplaceShifts, setMarketplaceShifts] = useState<Shift[]>([]);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const [xlsxLoading, setXlsxLoading] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState("");

  // ---------- Load schedule from /api/schedule ----------

  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) {
          setScheduleError("Could not load schedule.");
          return;
        }
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

  // Doctors list from schedule
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

  // ---------- Contacts load (DB + localStorage) ----------

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
      setSelectedMyShiftIndex("");
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

  const handleSaveContact = async () => {
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

  // ---------- My future shifts (for "shift to get rid of") ----------

  const myFutureShifts = useMemo(() => {
    if (!selectedDoctor) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return scheduleShifts
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => {
        const docMatches =
          (s.doctor || "").trim().toLowerCase() ===
          selectedDoctor.trim().toLowerCase();
        if (!docMatches) return false;

        const d = new Date(s.date + "T00:00:00");
        return d >= today;
      })
      .sort((a, b) =>
        `${a.s.date} ${a.s.startTime}`.localeCompare(
          `${b.s.date} ${b.s.startTime}`
        )
      );
  }, [selectedDoctor, scheduleShifts]);

  const myShift: Shift | null =
    selectedMyShiftIndex === ""
      ? null
      : scheduleShifts[parseInt(selectedMyShiftIndex, 10)] ?? null;

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

  // ---------- Tradeable marketplace shifts (base filter) ----------

  const tradeableShifts = useMemo(() => {
    if (marketplaceShifts.length === 0) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const nameLower = selectedDoctor.trim().toLowerCase();

    return marketplaceShifts.filter((s) => {
      const d = new Date(s.date + "T00:00:00");
      if (d < today) return false;

      const docTrimmed = (s.doctor || "").trim();
      if (!docTrimmed) return false; // no doctor, not tradeable

      if (nameLower) {
        const docLower = docTrimmed.toLowerCase();
        if (docLower === nameLower) return false; // it's me
      }

      return true;
    });
  }, [marketplaceShifts, selectedDoctor]);

  // ---------- Grouped view for debugging / overview ----------

  const groupedDays: GroupedDay[] = useMemo(() => {
    if (!tradeableShifts.length) return [];

    const byDate: Record<string, Shift[]> = {};
    for (const s of tradeableShifts) {
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
  }, [tradeableShifts]);

  // ---------- Trade candidates: compare myShift vs marketplace ----------

  const tradeCandidates: TradeCandidate[] = useMemo(() => {
    if (!myShift || !tradeableShifts.length) return [];

    const { start: myStart, end: myEnd } = getShiftDateTimes(myShift);
    const meLower = (myShift.doctor || "").trim().toLowerCase();

    // All of *my* future shifts from schedule (for overlap checks)
    const myAllFutureShifts = scheduleShifts.filter((s) => {
      const docMatches =
        (s.doctor || "").trim().toLowerCase() === meLower;
      if (!docMatches) return false;
      const d = new Date(s.date + "T00:00:00");
      return d >= new Date(myShift.date + "T00:00:00");
    });

    const candidates: TradeCandidate[] = [];

    for (const candidate of tradeableShifts) {
      const { start: candStart, end: candEnd } = getShiftDateTimes(candidate);

      // 1) If I take candidate, I drop myShift.
      // Check: does candidate overlap with any of my OTHER shifts?
      const overlapsMe = myAllFutureShifts.some((s) => {
        if (s === myShift) return false; // I'm dropping this one
        const { start, end } = getShiftDateTimes(s);
        return overlapsInterval(candStart, candEnd, start, end);
      });
      if (overlapsMe) {
        continue; // discard this candidate
      }

      // 2) Short-turnaround checks

      // For ME taking THEIR shift:
      const myPrevEnd = findPreviousShiftEnd(
        scheduleShifts,
        myShift.doctor,
        candStart,
        [myShift]
      );
      const myShort =
        myPrevEnd !== null && hoursDiff(candStart, myPrevEnd) < 12;

      // For THEM taking MY shift:
      const theirPrevEnd = findPreviousShiftEnd(
        scheduleShifts,
        candidate.doctor,
        myStart,
        [candidate]
      );
      const theirShort =
        theirPrevEnd !== null && hoursDiff(myStart, theirPrevEnd) < 12;

      candidates.push({ candidate, myShort, theirShort });
    }

    // Simple sort: by candidate date/time
    candidates.sort((a, b) =>
      `${a.candidate.date} ${a.candidate.startTime}`.localeCompare(
        `${b.candidate.date} ${b.candidate.startTime}`
      )
    );

    return candidates;
  }, [myShift, tradeableShifts, scheduleShifts]);

  // ---------- Render ----------

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Trade Fishing (Prototype)</h1>
      <p style={{ marginBottom: "0.75rem" }}>
        Tell me <strong>who you are</strong>, which shift you want to{" "}
        <strong>get rid of</strong>, and upload a MetricAid marketplace{" "}
        <code>.xlsx</code>. I’ll show you{" "}
        <strong>future trade candidates</strong> that don’t overlap your
        schedule and flag short-turnaround risks for either side.
      </p>

      {scheduleError && (
        <p style={{ color: "red", marginBottom: "0.75rem" }}>
          {scheduleError}
        </p>
      )}

      {/* 1. Pick your name + contact info */}
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
          This is used to{" "}
          <strong>identify which shifts are yours</strong> when we look at the
          marketplace.
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

      {/* 2. Pick your shift to give away */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>2. Pick the shift you want to trade away</h2>
        {!selectedDoctor && (
          <p>Select your name above to see your future shifts.</p>
        )}

        {selectedDoctor && myFutureShifts.length === 0 && (
          <p>No future shifts found for Dr. {selectedDoctor}.</p>
        )}

        {selectedDoctor && myFutureShifts.length > 0 && (
          <>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
              These are your <strong>future</strong> shifts from the ICS
              schedule.
            </p>
            <select
              value={selectedMyShiftIndex}
              onChange={(e) => setSelectedMyShiftIndex(e.target.value)}
              style={{ width: "100%", padding: "0.5rem" }}
            >
              <option value="">-- Choose a shift --</option>
              {myFutureShifts.map(({ s, index }) => {
                const label = `${formatHumanDate(
                  s.date
                )}, ${s.shiftName} ${s.startTime}–${s.endTime}`;
                return (
                  <option key={index} value={index}>
                    {label}
                  </option>
                );
              })}
            </select>

            {myShift && (
              <p style={{ marginTop: "0.5rem", fontSize: "0.9rem" }}>
                <strong>Your chosen shift:</strong>{" "}
                {formatHumanDate(myShift.date)} – {myShift.shiftName} (
                {myShift.startTime}–{myShift.endTime})
              </p>
            )}
          </>
        )}
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
        <h2 style={{ marginTop: 0 }}>3. Upload your marketplace .xlsx</h2>
        <p style={{ fontSize: "0.9rem", color: "#555" }}>
          Export the <strong>MetricAid marketplace</strong> as{" "}
          <code>.xlsx</code> (with your schedule included) and upload it here.
          It usually feels best to <strong>choose your name</strong> and your{" "}
          <strong>shift to trade</strong> first, then upload.
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

      {/* 4. Trade candidates */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>4. Suggested trade targets</h2>

        {!myShift && (
          <p>
            Pick your name and the shift you want to trade away above to see
            suggestions here.
          </p>
        )}

        {myShift && marketplaceShifts.length === 0 && !xlsxLoading && !xlsxError && (
          <p>Upload a marketplace <code>.xlsx</code> to see trade options.</p>
        )}

        {myShift && tradeableShifts.length > 0 && tradeCandidates.length === 0 && (
          <p>
            Parsed <strong>{tradeableShifts.length}</strong> future marketplace
            shifts, but none are suitable after removing overlapping shifts and
            your own shifts.
          </p>
        )}

        {myShift && tradeCandidates.length > 0 && (
          <>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
              Found <strong>{tradeCandidates.length}</strong> potential trade
              candidates. Overlapping shifts for you have already been removed.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table
                border={1}
                cellPadding={4}
                style={{ borderCollapse: "collapse", minWidth: 750 }}
              >
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Shift</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Doctor</th>
                    <th>Turnaround risk</th>
                    <th>Raw cell text</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeCandidates.map((t, i) => {
                    const { candidate, myShort, theirShort } = t;
                    let riskText = "OK (≥ 12h for both)";
                    let riskColor = "#16a34a";

                    if (myShort || theirShort) {
                      riskColor = "#dc2626";
                      riskText = "SHORT TURNAROUND ";
                      if (myShort) riskText += "(for YOU) ";
                      if (theirShort) riskText += "(for THEM)";
                    }

                    return (
                      <tr key={i}>
                        <td>{formatHumanDate(candidate.date)}</td>
                        <td>{candidate.shiftName}</td>
                        <td>{candidate.startTime}</td>
                        <td>{candidate.endTime}</td>
                        <td>{candidate.doctor}</td>
                        <td style={{ color: riskColor }}>{riskText}</td>
                        <td>
                          <pre
                            style={{
                              margin: 0,
                              whiteSpace: "pre-wrap",
                              fontSize: "0.75rem",
                            }}
                          >
                            {candidate.rawCell}
                          </pre>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* Extra: grouped marketplace view for sanity check */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Marketplace overview (filtered)</h2>
        {!tradeableShifts.length && marketplaceShifts.length > 0 && (
          <p>
            Parsed <strong>{marketplaceShifts.length}</strong> shifts, but none
            are future tradeable shifts after basic filtering (no doctor name,
            your own shifts, past dates).
          </p>
        )}

        {tradeableShifts.length > 0 && groupedDays.length > 0 && (
          <>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
              Future marketplace shifts with{" "}
              <strong>no empty doctor names</strong> and excluding any shifts
              belonging to{" "}
              {selectedDoctor ? `Dr. ${selectedDoctor}` : "the selected user"}.
            </p>
            <div style={{ maxHeight: 400, overflowY: "auto" }}>
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
