"use client";

import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

// ---------- Types ----------

type Shift = {
  date: string; // "2025-11-17"
  shiftName: string;
  startTime: string; // "05:00"
  endTime: string;   // "09:00"
  doctor: string;
  location?: string;
  raw?: string;
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

type AnalyzedCandidate = {
  candidate: Shift;
  offsetDays: number; // candidate - myShift (in days)
  sameType: boolean;  // same weekend/weekday + same time-of-day bucket
  myShort: boolean;
  theirShort: boolean;
};

type UsageMode = "sameDay" | "getTogether" | "periHang" | "tradeFishing";

type ModeUsageEvent = {
  id: string;
  mode: UsageMode;
  timestamp: string;
  doctorName?: string;
  extra?: string;
};

const CONTACTS_STORAGE_KEY = "metriManagerContacts";
const USAGE_LOG_KEY = "metriManagerUsageLog";

// ---------- Time helpers ----------

function toDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time || "00:00"}:00`);
}

function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = toDateTime(shift.date, shift.startTime);
  let end = toDateTime(shift.date, shift.endTime);

  // Overnight (e.g. 23:00–09:00)
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  return { start, end };
}

function hoursDiff(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60);
}

function sameDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0 = Sun, 6 = Sat
  return day === 0 || day === 6;
}

function timeBucketFromDate(date: Date): "morning" | "day" | "evening" | "night" {
  const h = date.getHours();
  if (h >= 5 && h < 10) return "morning";
  if (h >= 10 && h < 17) return "day";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

function timeBucketFromShift(shift: Shift): "morning" | "day" | "evening" | "night" {
  const { start } = getShiftDateTimes(shift);
  return timeBucketFromDate(start);
}

function isSameShift(a: Shift, b: Shift): boolean {
  return (
    a.date === b.date &&
    a.shiftName === b.shiftName &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    (a.doctor || "").trim().toLowerCase() ===
      (b.doctor || "").trim().toLowerCase()
  );
}

function overlaps(a: Shift, b: Shift): boolean {
  const { start: aStart, end: aEnd } = getShiftDateTimes(a);
  const { start: bStart, end: bEnd } = getShiftDateTimes(b);
  return aStart < bEnd && aEnd > bStart;
}

function overlapsMySchedule(
  candidate: Shift,
  allShifts: Shift[],
  myDoctor: string,
  myShift: Shift
): boolean {
  return allShifts.some((s) => {
    if ((s.doctor || "").trim().toLowerCase() !== myDoctor.trim().toLowerCase()) {
      return false;
    }
    if (isSameShift(s, myShift)) return false; // I'm giving this one away
    return overlaps(candidate, s);
  });
}

function findPreviousShiftEnd(
  allShifts: Shift[],
  doctor: string,
  referenceStart: Date,
  ignoreMatch?: (s: Shift) => boolean
): Date | null {
  const ends: Date[] = [];
  for (const s of allShifts) {
    if ((s.doctor || "").trim().toLowerCase() !== doctor.trim().toLowerCase()) {
      continue;
    }
    if (ignoreMatch && ignoreMatch(s)) continue;
    const { end } = getShiftDateTimes(s);
    if (!isNaN(end.getTime()) && end < referenceStart) {
      ends.push(end);
    }
  }
  if (!ends.length) return null;
  ends.sort((a, b) => b.getTime() - a.getTime());
  return ends[0];
}

// ---------- Marketplace XLSX parsing helpers ----------

/** Detect cells like "Mon, Nov 17" */
function isDateHeader(value: string): boolean {
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value.trim());
}

/**
 * Convert "Mon, Nov 17" into an ISO date string using this rule:
 *  - Build the date in the current year
 *  - If it's at least 7 days in the past, treat it as NEXT year
 *  - Otherwise treat it as THIS year
 */
function normalizeDateWith7DayBuffer(header: string): string | null {
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

  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const base = new Date(today.getFullYear(), m, day);

  const diffMs = base.getTime() - todayMidnight.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  let finalYear = today.getFullYear();
  if (diffDays < -7) {
    // More than 7 days in the past → treat as next year
    finalYear = today.getFullYear() + 1;
  }

  const finalDate = new Date(finalYear, m, day);
  return finalDate.toISOString().slice(0, 10);
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

  for (let r = range.s.r; r <= range.e.r; r++) {
    // First pass: update any date headers
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddr];
      const v = typeof cell?.v === "string" ? cell.v.trim() : "";
      if (!v) continue;

      if (isDateHeader(v)) {
        const normalized = normalizeDateWith7DayBuffer(v);
        if (normalized) {
          datesByCol[c] = normalized;
        }
      }
    }

    // Second pass: look for shift cells (location + shift + times)
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[cellAddr];
      const value = typeof cell?.v === "string" ? cell.v : "";
      if (!value) continue;

      const activeDate = datesByCol[c];
      if (!activeDate) continue; // we don't know which day this column is yet

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
        raw: value,
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

// ---------- Trade-analysis helpers ----------

function analyzeCandidate(
  myShift: Shift,
  candidate: Shift,
  allShifts: Shift[]
): AnalyzedCandidate {
  const { start: myStart } = getShiftDateTimes(myShift);
  const { start: theirStart } = getShiftDateTimes(candidate);

  const myDoctor = (myShift.doctor || "").trim();
  const theirDoctor = (candidate.doctor || "").trim();

  // Short-turnaround checks
  let myShort = false;
  let theirShort = false;

  const myPrev = findPreviousShiftEnd(
    allShifts,
    myDoctor,
    theirStart,
    (s) => isSameShift(s, myShift)
  );
  if (myPrev) {
    const gap = hoursDiff(theirStart, myPrev);
    if (gap < 12) myShort = true;
  }

  const theirPrev = findPreviousShiftEnd(
    allShifts,
    theirDoctor,
    myStart,
    (s) => isSameShift(s, candidate)
  );
  if (theirPrev) {
    const gap = hoursDiff(myStart, theirPrev);
    if (gap < 12) theirShort = true;
  }

  const offsetMs = theirStart.getTime() - myStart.getTime();
  const offsetDays = offsetMs / (1000 * 60 * 60 * 24);

  const sameWeekendFlag = isWeekend(myShift.date) === isWeekend(candidate.date);
  const sameBucket =
    timeBucketFromShift(myShift) === timeBucketFromShift(candidate);
  const sameType = sameWeekendFlag && sameBucket;

  return {
    candidate,
    offsetDays,
    sameType,
    myShort,
    theirShort,
  };
}

// ---------- Metrics helpers ----------

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function logModeUsage(event: ModeUsageEvent) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(USAGE_LOG_KEY);
    const arr = raw ? (JSON.parse(raw) as ModeUsageEvent[]) : [];
    arr.push(event);
    window.localStorage.setItem(USAGE_LOG_KEY, JSON.stringify(arr));
  } catch {
    // ignore
  }
}

// ---------- Main component ----------

export default function TradeFishingPage() {
  // Schedule (ICS) for everyone
  const [scheduleShifts, setScheduleShifts] = useState<Shift[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Marketplace XLSX
  const [marketplaceShifts, setMarketplaceShifts] = useState<Shift[]>([]);
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const [xlsxLoading, setXlsxLoading] = useState(false);

  // Selected doctor & shift
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedMyShiftIndex, setSelectedMyShiftIndex] = useState("");

  // Contacts
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  // ---------- Load schedule from /api/schedule ----------

  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) {
          setScheduleError("Could not load schedule.");
          return;
        }
        const sorted = [...data].sort((a, b) =>
          `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`)
        );
        setScheduleShifts(sorted);

        // Log that Trade Fishing was opened successfully
        logModeUsage({
          id: makeId(),
          mode: "tradeFishing",
          timestamp: new Date().toISOString(),
          extra: "open",
        });
      })
      .catch(() => setScheduleError("Could not load schedule."));
  }, []);

  // ---------- Load contacts (DB + localStorage fallback) ----------

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
            preferred:
              (row.preferred as Contact["preferred"]) ?? "none",
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

  // ---------- Doctor list (from schedule) ----------

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

  const myContact: Contact | undefined =
    selectedDoctor && contacts[selectedDoctor]
      ? contacts[selectedDoctor]
      : undefined;

  const myPreferenceText = myContact
    ? formatPreference(myContact)
    : "No contact info saved for you yet.";

  // Update contactDraft when doctor changes
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

  // ---------- Marketplace XLSX upload ----------

  const handleXlsxChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setXlsxError(null);
    setXlsxLoading(true);
    setMarketplaceShifts([]);

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseMarketplaceXlsx(buffer);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const futureOnly = parsed.filter((s) => {
        const d = new Date(s.date + "T00:00:00");
        return d >= today;
      });

      setMarketplaceShifts(futureOnly);
      if (futureOnly.length === 0) {
        setXlsxError(
          "Parsed 0 future shifts from this file. The layout or date range may be different than expected."
        );
      } else {
        // Log successful XLSX upload parsing
        logModeUsage({
          id: makeId(),
          mode: "tradeFishing",
          timestamp: new Date().toISOString(),
          doctorName: selectedDoctor || undefined,
          extra: "xlsx-upload",
        });
      }
    } catch (err) {
      console.error(err);
      setXlsxError("Failed to read XLSX – check console for details.");
    } finally {
      setXlsxLoading(false);
    }
  };

  // ---------- My future shifts (from schedule) ----------

  const myFutureShifts = useMemo(() => {
    if (!selectedDoctor) return [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return scheduleShifts.filter((s) => {
      if (
        (s.doctor || "").trim().toLowerCase() !==
        selectedDoctor.trim().toLowerCase()
      ) {
        return false;
      }
      const d = new Date(s.date + "T00:00:00");
      return d >= today;
    });
  }, [scheduleShifts, selectedDoctor]);

  const myShift: Shift | null =
    selectedMyShiftIndex === ""
      ? null
      : myFutureShifts[parseInt(selectedMyShiftIndex, 10)] || null;

  // ---------- Trade analysis ----------

  const analyzed = useMemo(() => {
    if (!myShift) return { bestByDate: [] as AnalyzedCandidate[], bestByType: [] as AnalyzedCandidate[], all: [] as AnalyzedCandidate[] };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const myDoctor = selectedDoctor.trim().toLowerCase();

    const filteredCandidates = marketplaceShifts.filter((s) => {
      // Skip if no doctor
      const doc = (s.doctor || "").trim();
      if (!doc) return false;

      // Skip my own shifts – can't trade with myself
      if (doc.toLowerCase() === myDoctor) return false;

      // Only future dates (should already be true)
      const d = new Date(s.date + "T00:00:00");
      if (d < today) return false;

      // Remove anything that overlaps my schedule (except the shift I'm trading away)
      if (overlapsMySchedule(s, scheduleShifts, selectedDoctor, myShift)) {
        return false;
      }

      return true;
    });

    const analyses = filteredCandidates.map((c) =>
      analyzeCandidate(myShift, c, scheduleShifts)
    );

    // All viable, sorted by date/time
    const all = [...analyses].sort((a, b) => {
      if (a.candidate.date !== b.candidate.date) {
        return a.candidate.date.localeCompare(b.candidate.date);
      }
      if (a.candidate.startTime !== b.candidate.startTime) {
        return a.candidate.startTime.localeCompare(b.candidate.startTime);
      }
      return a.candidate.shiftName.localeCompare(b.candidate.shiftName);
    });

    // Best by date proximity (closest offset first)
    const bestByDate = [...analyses].sort((a, b) => {
      const diffA = Math.abs(a.offsetDays);
      const diffB = Math.abs(b.offsetDays);
      if (diffA !== diffB) return diffA - diffB;
      // tie-breaker: actual date/time
      const dateCmp = a.candidate.date.localeCompare(b.candidate.date);
      if (dateCmp !== 0) return dateCmp;
      return a.candidate.startTime.localeCompare(b.candidate.startTime);
    });

    // Best by shift type: same weekend/weekday + same bucket
    const bestByType = analyses
      .filter((a) => a.sameType)
      .sort((a, b) => {
        if (a.candidate.date !== b.candidate.date) {
          return a.candidate.date.localeCompare(b.candidate.date);
        }
        if (a.candidate.startTime !== b.candidate.startTime) {
          return a.candidate.startTime.localeCompare(b.candidate.startTime);
        }
        return a.candidate.shiftName.localeCompare(b.candidate.shiftName);
      });

    return { bestByDate, bestByType, all };
  }, [myShift, marketplaceShifts, scheduleShifts, selectedDoctor]);

  const { bestByDate, bestByType, all } = analyzed;

  // ---------- Render helpers ----------

  const renderCandidateRow = (a: AnalyzedCandidate, index: number) => {
    const s = a.candidate;
    const warnings: string[] = [];
    if (a.myShort || a.theirShort) {
      let label = "Short turnaround: ";
      const parts: string[] = [];
      if (a.myShort) parts.push("for YOU");
      if (a.theirShort) parts.push("for THEM");
      label += parts.join(" & ");
      warnings.push(label);
    }

    const offsetLabel =
      a.offsetDays === 0
        ? "Same day"
        : a.offsetDays > 0
        ? `+${Math.round(a.offsetDays)} days`
        : `${Math.round(a.offsetDays)} days`;

    return (
      <tr key={index}>
        <td>{formatHumanDate(s.date)}</td>
        <td>{s.shiftName}</td>
        <td>
          {s.startTime}–{s.endTime}
        </td>
        <td>{s.doctor}</td>
        <td>{offsetLabel}</td>
        <td style={{ color: a.myShort || a.theirShort ? "red" : "#16a34a" }}>
          {warnings.length ? warnings.join("; ") : "OK (no short turnaround flagged)"}
        </td>
      </tr>
    );
  };

  const handleBack = () => {
    if (typeof window !== "undefined") {
      window.location.href = "/";
    }
  };

  // ---------- JSX ----------

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "0.75rem",
          marginBottom: "0.75rem",
        }}
      >
        <div>
          <h1>Trade Fishing (Marketplace Prototype)</h1>
          <p style={{ maxWidth: 800 }}>
            Follow the instructions below and I&apos;ll help you find the best possible
            trade from all available marketplace shifts.
          </p>
        </div>
        <button
          type="button"
          onClick={handleBack}
          style={{
            padding: "0.4rem 0.8rem",
            borderRadius: "999px",
            border: "1px solid #333",
            background: "#fff",
            cursor: "pointer",
            fontSize: "0.85rem",
            whiteSpace: "nowrap",
          }}
        >
          ← Back to Metri-Manager
        </button>
      </div>

      {scheduleError && (
        <p style={{ color: "red" }}>Schedule error: {scheduleError}</p>
      )}

      {/* ---------- Step 1: Pick your name ---------- */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1rem",
        }}
      >
        <h2>1. Pick your name</h2>

        {doctorsFromSchedule.length === 0 ? (
          <>
            <p style={{ color: "red" }}>
              Could not load doctor list from the schedule. You can still type
              your name manually.
            </p>
            <input
              type="text"
              value={selectedDoctor}
              onChange={(e) => {
                setSelectedDoctor(e.target.value);
                setSelectedMyShiftIndex("");
              }}
              placeholder="Your last name (e.g. Klassen)"
              style={{ width: "100%", maxWidth: 400, padding: "0.5rem" }}
            />
          </>
        ) : (
          <>
            <p style={{ marginBottom: "0.5rem" }}>
              Choose your name from the schedule doctor list.
            </p>
            <select
              value={selectedDoctor}
              onChange={(e) => {
                setSelectedDoctor(e.target.value);
                setSelectedMyShiftIndex("");
              }}
              style={{ width: "100%", maxWidth: 400, padding: "0.5rem" }}
            >
              <option value="">-- Choose your name --</option>
              {doctorsFromSchedule.map((doc) => (
                <option key={doc} value={doc}>
                  {doc}
                </option>
              ))}
            </select>
          </>
        )}

        {/* Contact registration */}
        {selectedDoctor && (
          <>
            <hr style={{ margin: "1rem 0" }} />
            <h3>Contact registration for Metri-Manager</h3>
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
                  consent to this site storing my contact information on this
                  device so I can use it while fishing for trades.
                </p>
              </>
            )}
          </>
        )}
      </section>

      {/* ---------- Step 2: Upload XLSX ---------- */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1rem",
        }}
      >
        <h2>2. Upload your MetricAid .xlsx</h2>
        <p style={{ maxWidth: 800 }}>
          Upload your MetricAid Excel Marketplace and I will find you the best
          matches, eliminate overlapping shifts, and warn you about short
          turnarounds. For instructions on how to create and download your
          MetricAid Excel Marketplace document click{" "}
          <a
            href="https://youtu.be/IgbLhb0BgFc"
            target="_blank"
            rel="noopener noreferrer"
          >
            here
          </a>
          .
        </p>
        <p
          style={{
            maxWidth: 800,
            fontSize: "0.9rem",
            color: "#b91c1c",
            fontStyle: "italic",
          }}
        >
          *WARNING: If your .xlsx document is more than one week old it may
          affect the validity of your results. It is highly recommended that you
          generate the document immediately before generating your Trade Fishing
          recommendations.
        </p>
        <div style={{ marginTop: "0.5rem" }}>
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={handleXlsxChange}
          />
        </div>
        {xlsxLoading && <p>Reading and parsing XLSX…</p>}
        {xlsxError && <p style={{ color: "red" }}>{xlsxError}</p>}
        {marketplaceShifts.length > 0 && !xlsxError && (
          <p>
            Parsed <strong>{marketplaceShifts.length}</strong> marketplace
            shifts.
          </p>
        )}
      </section>

      {/* ---------- Step 3: Pick the shift you're fishing with ---------- */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1rem",
        }}
      >
        <h2>3. Pick the shift you&apos;re fishing with</h2>
        {!selectedDoctor && (
          <p>Choose your name in step 1 first.</p>
        )}
        {selectedDoctor && marketplaceShifts.length === 0 && (
          <p>Upload your MetricAid .xlsx in step 2 first.</p>
        )}
        {selectedDoctor &&
          marketplaceShifts.length > 0 &&
          myFutureShifts.length === 0 && (
            <p>
              I couldn&apos;t find any future shifts for Dr. {selectedDoctor} on
              the schedule.
            </p>
          )}
        {selectedDoctor &&
          marketplaceShifts.length > 0 &&
          myFutureShifts.length > 0 && (
            <>
              <p>
                Choose which of your future shifts you are trying to get rid of.
              </p>
              <select
                value={selectedMyShiftIndex}
                onChange={(e) => {
                  setSelectedMyShiftIndex(e.target.value);

                  // Log that a user chose a shift to fish with
                  if (e.target.value !== "") {
                    logModeUsage({
                      id: makeId(),
                      mode: "tradeFishing",
                      timestamp: new Date().toISOString(),
                      doctorName: selectedDoctor || undefined,
                      extra: "choose-shift",
                    });
                  }
                }}
                style={{ width: "100%", maxWidth: 500, padding: "0.5rem" }}
              >
                <option value="">-- Choose your shift --</option>
                {myFutureShifts.map((s, index) => {
                  const label = `${formatHumanDate(
                    s.date
                  )} – ${s.shiftName} ${s.startTime}–${s.endTime}`;
                  return (
                    <option key={index} value={index}>
                      {label}
                    </option>
                  );
                })}
              </select>
            </>
          )}
      </section>

      {/* ---------- Step 4: Results ---------- */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1rem",
          marginBottom: "2rem",
        }}
      >
        <h2>4. Trade Fishing results</h2>
        {!myShift && (
          <p>
            Once you&apos;ve chosen your name and the shift you&apos;re fishing
            with, I&apos;ll suggest marketplace shifts that look like good
            trade targets.
          </p>
        )}

        {myShift && all.length === 0 && (
          <p>
            I couldn&apos;t find any marketplace shifts that are suitable
            trade targets (after removing overlaps and your own shifts).
          </p>
        )}

        {myShift && all.length > 0 && (
          <>
            <p>
              You&apos;re fishing with:{" "}
              <strong>
                {formatHumanDate(myShift.date)} – {myShift.shiftName}{" "}
                {myShift.startTime}–{myShift.endTime}
              </strong>
            </p>

            {/* Best by date */}
            <h3>Best matches by date proximity</h3>
            {bestByDate.length === 0 ? (
              <p>No date-based matches found.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table
                  border={1}
                  cellPadding={4}
                  style={{
                    borderCollapse: "collapse",
                    minWidth: 700,
                    marginBottom: "1rem",
                  }}
                >
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Shift</th>
                      <th>Time</th>
                      <th>Doctor</th>
                      <th>Date offset</th>
                      <th>Turnaround risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bestByDate.map((a, i) => renderCandidateRow(a, i))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Best by shift type */}
            <h3>Best matches by shift type</h3>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
              These are matches that are similar in weekend vs weekday and time
              of day (day/evening/night).
            </p>
            {bestByType.length === 0 ? (
              <p>No same-type matches found.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table
                  border={1}
                  cellPadding={4}
                  style={{
                    borderCollapse: "collapse",
                    minWidth: 700,
                    marginBottom: "1rem",
                  }}
                >
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Shift</th>
                      <th>Time</th>
                      <th>Doctor</th>
                      <th>Date offset</th>
                      <th>Turnaround risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bestByType.map((a, i) => renderCandidateRow(a, i))}
                  </tbody>
                </table>
              </div>
            )}

            {/* All possibilities */}
            <h3>All viable marketplace options</h3>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
              Every marketplace shift that doesn&apos;t overlap your schedule or
              belong to you, sorted by date.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table
                border={1}
                cellPadding={4}
                style={{ borderCollapse: "collapse", minWidth: 700 }}
              >
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Shift</th>
                    <th>Time</th>
                    <th>Doctor</th>
                    <th>Date offset</th>
                    <th>Turnaround risk</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((a, i) => renderCandidateRow(a, i))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
