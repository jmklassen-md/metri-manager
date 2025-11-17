"use client";

import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

// ---------- Types ----------

type Shift = {
  date: string;      // "2025-11-17"
  shiftName: string; // "R5", "R-PM1", etc.
  startTime: string; // "05:00"
  endTime: string;   // "09:00"
  doctor: string;
  location?: string;
  raw?: string;
};

type MarketplaceShift = {
  date: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  doctor: string;
  rawCell: string;
};

type TradeSuggestion = {
  candidate: MarketplaceShift;
  similarityScore: number;
  similarityLabel: string;
  myShort: boolean;
  theirShort: boolean;
  hasShort: boolean;
  weekendBonus: boolean;
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

// ---------- Constants ----------

const CONTACTS_STORAGE_KEY = "metriManagerContacts";

// ---------- Time helpers ----------

function toDateTime(date: string, time: string): Date {
  const t = time && time.length >= 3 ? time : "00:00";
  return new Date(`${date}T${t}:00`);
}

function getShiftDateTimes(shift: { date: string; startTime: string; endTime: string }) {
  const start = toDateTime(shift.date, shift.startTime);
  let end = toDateTime(shift.date, shift.endTime);

  // Overnight (e.g., 23:00–09:00)
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return { start, end };
}

function hoursDiff(later: Date, earlier: Date) {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60);
}

function daysDiff(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00");
  const b = new Date(dateB + "T00:00:00");
  const ms = a.getTime() - b.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=Sun, 6=Sat
  return day === 0 || day === 6;
}

function timeBucketOf(shift: { startTime: string }) {
  const [hStr] = shift.startTime.split(":");
  const h = parseInt(hStr || "0", 10);
  if (h >= 22 || h < 6) return "night";
  if (h >= 6 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "day";
  return "evening";
}

function timeBucketsAdjacent(a: string, b: string): boolean {
  const order = ["night", "morning", "day", "evening", "night2"] as const;
  const idxA = order.indexOf(a as any);
  const idxB = order.indexOf(b as any);
  return Math.abs(idxA - idxB) === 1;
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

// ---------- Marketplace XLSX parsing ----------

function isDateHeader(value: string): boolean {
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value.trim());
}

function normalizeDate(header: string, fallbackYear?: number): string | null {
  const parts = header.replace(",", "").split(/\s+/);
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
  return d.toISOString().slice(0, 10);
}

function extractDoctorName(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "--") return "";
  const match = trimmed.match(/[A-Za-z]+/);
  return match ? match[0] : trimmed;
}

function parseMarketplaceXlsx(arrayBuffer: ArrayBuffer): MarketplaceShift[] {
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const ref = sheet["!ref"];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);
  const datesByCol: (string | null)[] = new Array(range.e.c + 1).fill(null);

  const shifts: MarketplaceShift[] = [];
  let detectedYear: number | undefined;

  for (let r = range.s.r; r <= range.e.r; r++) {
    // First pass: date headers
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

    // Second pass: shift cells
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

// ---------- Helper: previous shift end for a doctor ----------

function findPreviousShiftEnd(
  allShifts: Shift[],
  doctor: string,
  referenceStart: Date,
  ignore: { date: string; startTime: string; endTime: string }[] = []
): Date | null {
  const lowerDoc = doctor.trim().toLowerCase();
  const ends: Date[] = [];

  for (const s of allShifts) {
    if ((s.doctor || "").trim().toLowerCase() !== lowerDoc) continue;

    if (
      ignore.some(
        (ig) =>
          ig.date === s.date &&
          ig.startTime === s.startTime &&
          ig.endTime === s.endTime
      )
    ) {
      continue;
    }

    const { end } = getShiftDateTimes(s);
    if (!isNaN(end.getTime()) && end < referenceStart) {
      ends.push(end);
    }
  }

  if (!ends.length) return null;
  ends.sort((a, b) => b.getTime() - a.getTime());
  return ends[0];
}

// ---------- Main component ----------

export default function TradeFishingPage() {
  // ICS schedule
  const [scheduleShifts, setScheduleShifts] = useState<Shift[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Contacts
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [contactsLoaded, setContactsLoaded] = useState(false);

  // Step 1 – pick doctor + contact info
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  // Step 2 – marketplace XLSX
  const [marketplaceShifts, setMarketplaceShifts] = useState<MarketplaceShift[]>(
    []
  );
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  const [xlsxLoading, setXlsxLoading] = useState(false);

  // Step 3 – shift you're fishing with
  const [selectedMyShiftIndex, setSelectedMyShiftIndex] = useState("");

  // ---------- Load schedule from ICS (/api/schedule) ----------

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
      })
      .catch(() => setScheduleError("Could not load schedule."));
  }, []);

  // ---------- Load contacts (DB + localStorage) ----------

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
        // fallback to localStorage only
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

  // persist contacts locally
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        CONTACTS_STORAGE_KEY,
        JSON.stringify(contacts)
      );
    } catch {
      // ignore
    }
  }, [contacts]);

  // ---------- Derived doctor list from ICS ----------

  const doctors = useMemo(
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

  // When doctor changes, update contact draft
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

  const myEmail = myContact?.email || "";
  const myPhone = myContact?.phone || "";

  const myPreferenceText = myContact
    ? formatPreference(myContact)
    : "No contact info saved for you yet.";

  // ---------- Future shifts for selected doctor (from ICS) ----------

  const myFutureShifts = useMemo(() => {
    if (!selectedDoctor) return [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return scheduleShifts.filter((s) => {
      const docMatches =
        (s.doctor || "").trim().toLowerCase() ===
        selectedDoctor.trim().toLowerCase();
      if (!docMatches) return false;
      const d = new Date(s.date + "T00:00:00");
      return d >= today;
    });
  }, [selectedDoctor, scheduleShifts]);

  const myShift: Shift | null =
    selectedMyShiftIndex === ""
      ? null
      : myFutureShifts[parseInt(selectedMyShiftIndex, 10)] || null;

  // ---------- Handle saving contact ----------

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

  // ---------- Handle XLSX upload ----------

  const handleXlsxChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setXlsxError(null);
    setXlsxLoading(true);
    setMarketplaceShifts([]);

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseMarketplaceXlsx(buffer);

      // Filter: must have doctor name, and not be the same doctor as you
      const filtered = parsed.filter((s) => {
        if (!s.doctor || s.doctor.trim() === "") return false;
        if (
          selectedDoctor &&
          s.doctor.trim().toLowerCase() ===
            selectedDoctor.trim().toLowerCase()
        ) {
          return false;
        }
        return true;
      });

      setMarketplaceShifts(filtered);
      if (filtered.length === 0) {
        setXlsxError(
          "Parsed 0 usable marketplace shifts (no doctor names or only your own shifts)."
        );
      }
    } catch (err) {
      console.error(err);
      setXlsxError("Failed to read XLSX – check console for details.");
    } finally {
      setXlsxLoading(false);
    }
  };

  // ---------- Build trade suggestions ----------

  const suggestions: TradeSuggestion[] = useMemo(() => {
    if (!myShift || !selectedDoctor || !marketplaceShifts.length) return [];

    const myDoctor = selectedDoctor;
    const { start: myStart } = getShiftDateTimes(myShift);

    // All of *my* shifts from ICS (for overlap + previous shift)
    const myAllShifts = scheduleShifts.filter(
      (s) =>
        (s.doctor || "").trim().toLowerCase() ===
        myDoctor.trim().toLowerCase()
    );

    return marketplaceShifts
      .map((cand) => {
        // 1) Overlap check: candidate shift vs ALL my other ICS shifts (excluding myShift)
        const { start: candStart, end: candEnd } = getShiftDateTimes(cand);

        const overlapsMyOtherShift = myAllShifts.some((s) => {
          if (
            s.date === myShift.date &&
            s.startTime === myShift.startTime &&
            s.endTime === myShift.endTime
          ) {
            return false; // ignore the shift I'm trying to get rid of
          }
          const { start, end } = getShiftDateTimes(s);
          return start < candEnd && end > candStart;
        });

        if (overlapsMyOtherShift) {
          return null; // not a feasible trade
        }

        // 2) Short-turnaround checks
        const myPrev = findPreviousShiftEnd(
          scheduleShifts,
          myDoctor,
          candStart,
          [myShift]
        );
        const myShort = myPrev ? hoursDiff(candStart, myPrev) < 12 : false;

        const otherDoctor = cand.doctor;
        const theirPrev = findPreviousShiftEnd(
          scheduleShifts,
          otherDoctor,
          myStart,
          [
            {
              date: cand.date,
              startTime: cand.startTime,
              endTime: cand.endTime,
            },
          ]
        );
        const theirShort = theirPrev ? hoursDiff(myStart, theirPrev) < 12 : false;

        const hasShort = myShort || theirShort;

        // 3) Similarity scoring
        let score = 0;

        // same shift name
        if (cand.shiftName.trim() === myShift.shiftName.trim()) {
          score += 3;
        }

        // time-of-day bucket
        const bucketMine = timeBucketOf(myShift);
        const bucketCand = timeBucketOf(cand);
        if (bucketMine === bucketCand) {
          score += 2;
        } else if (timeBucketsAdjacent(bucketMine, bucketCand)) {
          score += 1;
        }

        // date proximity
        const deltaDays = Math.abs(daysDiff(cand.date, myShift.date));
        if (deltaDays === 0) score += 3;
        else if (deltaDays <= 1) score += 2;
        else if (deltaDays <= 3) score += 1;
        else if (deltaDays <= 7) score += 0.5;

        // weekday/weekend match
        const myWeekend = isWeekend(myShift.date);
        const candWeekend = isWeekend(cand.date);
        const weekendBonus = myWeekend === candWeekend;
        if (weekendBonus) score += 1;

        // label
        let label = "Loose match";
        if (score >= 6.5) label = "Excellent match";
        else if (score >= 4.5) label = "Good match";
        else if (score >= 2.5) label = "OK match";

        return {
          candidate: cand,
          similarityScore: score,
          similarityLabel: label,
          myShort,
          theirShort,
          hasShort,
          weekendBonus,
        } as TradeSuggestion;
      })
      .filter(Boolean)
      .sort((a, b) => {
        // non-short-turnaround first
        if (a!.hasShort !== b!.hasShort) {
          return a!.hasShort ? 1 : -1;
        }
        // higher score first
        if (b!.similarityScore !== a!.similarityScore) {
          return b!.similarityScore - a!.similarityScore;
        }
        // earlier date/time
        if (a!.candidate.date !== b!.candidate.date) {
          return a!.candidate.date.localeCompare(b!.candidate.date);
        }
        return a!.candidate.startTime.localeCompare(b!.candidate.startTime);
      }) as TradeSuggestion[];
  }, [
    myShift,
    selectedDoctor,
    marketplaceShifts,
    scheduleShifts,
  ]);

  // ---------- Render ----------

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Trade Fishing (Marketplace Prototype)</h1>
      <p style={{ maxWidth: 800 }}>
        Upload your MetricAid <code>.xlsx</code> marketplace export (the one
        that includes your own schedule plus marketplace icons). Then pick{" "}
        <strong>your name</strong> from the ICS schedule and choose the shift
        you&apos;re trying to get rid of. I&apos;ll suggest marketplace shifts
        that look like good trade targets, filter out overlaps with your other
        shifts, and flag short-turnaround risks.
      </p>

      {/* 1. Pick your name + contact info */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1.5rem",
        }}
      >
        <h2>1. Pick your name</h2>
        {scheduleError && (
          <p style={{ color: "red" }}>{scheduleError}</p>
        )}
        {!scheduleError && doctors.length === 0 && (
          <p>Loading schedule to build doctor list…</p>
        )}
        {doctors.length > 0 && (
          <select
            value={selectedDoctor}
            onChange={(e) => {
              setSelectedDoctor(e.target.value);
              setSelectedMyShiftIndex("");
            }}
            style={{ width: "100%", maxWidth: 400, padding: "0.5rem" }}
          >
            <option value="">-- Choose your name --</option>
            {doctors.map((doc) => (
              <option key={doc} value={doc}>
                {doc}
              </option>
            ))}
          </select>
        )}

        {/* Contact registration block (Same-Day style) */}
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
                  style={{
                    padding: "0.4rem 0.8rem",
                    marginBottom: "0.5rem",
                  }}
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
          marginTop: "1.5rem",
        }}
      >
        <h2>2. Upload your MetricAid .xlsx</h2>
        <p>
          Choose the MetricAid <code>.xlsx</code> export that includes your own
          shifts plus marketplace arrows. I&apos;ll parse it and pull out
          marketplace shifts that have a doctor name.
        </p>
        <input type="file" accept=".xlsx,.xls" onChange={handleXlsxChange} />
        {xlsxLoading && <p>Reading and parsing XLSX…</p>}
        {xlsxError && <p style={{ color: "red" }}>{xlsxError}</p>}
        {marketplaceShifts.length > 0 && !xlsxError && (
          <p>
            Parsed <strong>{marketplaceShifts.length}</strong> marketplace
            shifts with doctor names (excluding your own).
          </p>
        )}
      </section>

      {/* 3. Pick my shift */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1.5rem",
        }}
      >
        <h2>3. Pick the shift you&apos;re fishing with</h2>
        {!selectedDoctor && <p>Choose your name in step 1 first.</p>}
        {selectedDoctor && myFutureShifts.length === 0 && (
          <p>No future shifts found for Dr. {selectedDoctor} in the ICS.</p>
        )}
        {selectedDoctor && myFutureShifts.length > 0 && (
          <select
            value={selectedMyShiftIndex}
            onChange={(e) => setSelectedMyShiftIndex(e.target.value)}
            style={{ width: "100%", maxWidth: 500, padding: "0.5rem" }}
          >
            <option value="">-- Choose one of your future shifts --</option>
            {myFutureShifts.map((s, idx) => (
              <option key={`${s.date}-${s.shiftName}-${idx}`} value={idx}>
                {s.date} – {s.shiftName} {s.startTime}–{s.endTime}
              </option>
            ))}
          </select>
        )}
        {myShift && (
          <p style={{ marginTop: "0.5rem" }}>
            You&apos;re trying to trade away:{" "}
            <strong>
              {myShift.date} – {myShift.shiftName} {myShift.startTime}–
              {myShift.endTime}
            </strong>
          </p>
        )}
      </section>

      {/* 4. Results */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1.5rem",
          marginBottom: "2rem",
        }}
      >
        <h2>4. Trade Fishing results</h2>
        {!myShift && <p>Pick a shift in step 3 to see suggestions.</p>}
        {myShift && marketplaceShifts.length === 0 && (
          <p>Upload a marketplace .xlsx file in step 2 to see suggestions.</p>
        )}
        {myShift && marketplaceShifts.length > 0 && suggestions.length === 0 && (
          <p>
            No feasible trade suggestions found (after filtering overlaps and
            blank-doctor shifts).
          </p>
        )}

        {myShift && suggestions.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table
              border={1}
              cellPadding={4}
              style={{ borderCollapse: "collapse", minWidth: 800 }}
            >
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Shift</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Doctor</th>
                  <th>Similarity</th>
                  <th>Turnaround risk</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((sug, i) => (
                  <tr key={i}>
                    <td>{sug.candidate.date}</td>
                    <td>{sug.candidate.shiftName}</td>
                    <td>{sug.candidate.startTime}</td>
                    <td>{sug.candidate.endTime}</td>
                    <td>{sug.candidate.doctor}</td>
                    <td>
                      {sug.similarityLabel} ({sug.similarityScore.toFixed(1)})
                    </td>
                    <td
                      style={{
                        color: sug.hasShort ? "red" : "green",
                        fontWeight: 500,
                      }}
                    >
                      {sug.hasShort
                        ? `SHORT TURNAROUND ${
                            sug.myShort ? "(for YOU) " : ""
                          }${sug.theirShort ? "(for THEM)" : ""}`
                        : "OK (≥ 12h each)"}
                    </td>
                    <td style={{ fontSize: "0.85rem" }}>
                      {sug.weekendBonus
                        ? "Weekend/weekday pattern matches your shift."
                        : "Different weekend/weekday pattern."}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
} 