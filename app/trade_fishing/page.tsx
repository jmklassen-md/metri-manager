"use client";

import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

// ---------- Types ----------

type Shift = {
  date: string;      // "2025-11-17"
  shiftName: string; // "R-AM1", "Surge-AM", etc.
  startTime: string; // "08:00"
  endTime: string;   // "17:00"
  doctor: string;    // e.g. "Klassen"
  rawCell: string;   // original text for debugging
};

type Contact = {
  email: string;
  phone: string;
  preferred: "email" | "sms" | "either" | "none";
};

type TradeCandidate = {
  candidate: Shift;
  similarityScore: number;
  similarityLabel: string;
  myShort: boolean;
  theirShort: boolean;
  hasShort: boolean;
};

const CONTACTS_STORAGE_KEY = "metriManagerContactsTradeFishing";

// ---------- Basic helpers ----------

function isDateHeader(value: string): boolean {
  return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value.trim());
}

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

function extractDoctorName(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "--") return "";

  // e.g. "KlassenMa (FRCP R3) / Luo (M3)" -> "Klassen"
  const match = trimmed.match(/[A-Za-z]+/);
  return match ? match[0] : trimmed;
}

function toDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time || "00:00"}:00`);
}

function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = toDateTime(shift.date, shift.startTime);
  let end = toDateTime(shift.date, shift.endTime);

  // Overnight (23:00–09:00 etc.)
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return { start, end };
}

function hoursDiff(later: Date, earlier: Date) {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60);
}

function dateDiffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00");
  const db = new Date(b + "T00:00:00");
  const ms = da.getTime() - db.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0 = Sun, 6 = Sat
  return day === 0 || day === 6;
}

function timeOfDayBucket(time: string): "early" | "day" | "evening" | "night" {
  const [hStr] = time.split(":");
  const h = parseInt(hStr || "0", 10);
  if (h >= 5 && h < 12) return "early";   // 05–11
  if (h >= 12 && h < 17) return "day";    // 12–16
  if (h >= 17 && h < 22) return "evening"; // 17–21
  return "night";                          // 22–04
}

function bucketDistance(
  a: "early" | "day" | "evening" | "night",
  b: "early" | "day" | "evening" | "night"
): number {
  const order = ["early", "day", "evening", "night"] as const;
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  return Math.abs(ia - ib);
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

function shiftsOverlap(a: Shift, b: Shift): boolean {
  const { start: sa, end: ea } = getShiftDateTimes(a);
  const { start: sb, end: eb } = getShiftDateTimes(b);
  return sa < eb && sb < ea;
}

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

// ---------- Similarity scoring ----------

function computeSimilarity(myShift: Shift, candidate: Shift): {
  score: number;
  label: string;
} {
  let score = 0;
  const reasons: string[] = [];

  const myName = (myShift.shiftName || "").trim().toLowerCase();
  const candName = (candidate.shiftName || "").trim().toLowerCase();

  if (myName && candName && myName === candName) {
    score += 50;
    reasons.push("Exact match: same shift name");
  }

  const myBucket = timeOfDayBucket(myShift.startTime);
  const candBucket = timeOfDayBucket(candidate.startTime);
  const bDist = bucketDistance(myBucket, candBucket);

  if (bDist === 0) {
    score += 20;
    reasons.push("Same time-of-day");
  } else if (bDist === 1) {
    score += 10;
    reasons.push("Similar time-of-day");
  }

  const dayDiff = Math.abs(dateDiffDays(myShift.date, candidate.date));
  if (dayDiff === 0) {
    score += 30;
    reasons.push("Same day");
  } else if (dayDiff <= 1) {
    score += 25;
    reasons.push("Within 1 day");
  } else if (dayDiff <= 3) {
    score += 20;
    reasons.push("Within 3 days");
  } else if (dayDiff <= 7) {
    score += 10;
    reasons.push("Within 1 week");
  }

  // Weekend vs weekday bump
  const myWeekend = isWeekend(myShift.date);
  const candWeekend = isWeekend(candidate.date);
  if (myWeekend === candWeekend) {
    score += 10;
    reasons.push(myWeekend ? "Both weekend shifts" : "Both weekday shifts");
  }

  const label =
    reasons.length > 0
      ? `${reasons.join(" | ")} (score ${score})`
      : `Different type/offset (score ${score})`;

  return { score, label };
}

// ---------- XLSX parsing ----------

function parseMarketplaceXlsx(arrayBuffer: ArrayBuffer): Shift[] {
  const workbook = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const ref = sheet["!ref"];
  if (!ref) return [];

  const range = XLSX.utils.decode_range(ref);

  const datesByCol: (string | null)[] = new Array(range.e.c + 1).fill(null);
  const shifts: Shift[] = [];

  let detectedYear: number | undefined;

  for (let r = range.s.r; r <= range.e.r; r++) {
    // First pass: detect / update date headers
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

    // Second pass: look for shift cells
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

// ---------- Component ----------

export default function MarketplaceXlsxPage() {
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Contacts (local-only for now)
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  // Load contacts from localStorage once
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CONTACTS_STORAGE_KEY);
      const stored = raw ? (JSON.parse(raw) as Record<string, Contact>) : {};
      setContacts(stored);
    } catch {
      setContacts({});
    }
  }, []);

  // Persist contacts to localStorage when they change
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

  // Update contactDraft when selectedDoctor changes
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

  const handleSaveContact = () => {
    if (!selectedDoctor) return;
    setContacts((prev) => ({
      ...prev,
      [selectedDoctor]: {
        email: contactDraft.email.trim(),
        phone: contactDraft.phone.trim(),
        preferred: contactDraft.preferred,
      },
    }));
    setContactSavedMessage("Contact information saved on this device.");
    setTimeout(() => setContactSavedMessage(""), 3000);
  };

  const myContact: Contact | undefined =
    selectedDoctor && contacts[selectedDoctor]
      ? contacts[selectedDoctor]
      : undefined;

  const myPreferenceText = myContact
    ? formatPreference(myContact)
    : "No contact info saved for you yet.";

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setLoading(true);
    setShifts([]);
    setFileName(file.name);

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseMarketplaceXlsx(buffer);

      // Sort raw shifts by date + startTime
      parsed.sort((a, b) => {
        const d = a.date.localeCompare(b.date);
        if (d !== 0) return d;
        return a.startTime.localeCompare(b.startTime);
      });

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

  // ---------- My future shifts (from XLSX) ----------

  const [selectedMyShiftIndex, setSelectedMyShiftIndex] = useState("");

  useEffect(() => {
    // Reset selected shift if doctor changes or file changes
    setSelectedMyShiftIndex("");
  }, [selectedDoctor, fileName]);

  const myFutureShifts = useMemo(() => {
    if (!selectedDoctor) return [] as { s: Shift; index: number }[];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return shifts
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => {
        const docMatches =
          (s.doctor || "").trim().toLowerCase() ===
          selectedDoctor.trim().toLowerCase();
        if (!docMatches) return false;

        const d = new Date(s.date + "T00:00:00");
        return d >= today;
      })
      .sort((a, b) => {
        const d = a.s.date.localeCompare(b.s.date);
        if (d !== 0) return d;
        return a.s.startTime.localeCompare(b.s.startTime);
      });
  }, [shifts, selectedDoctor]);

  const myShift: Shift | null =
    selectedMyShiftIndex === ""
      ? null
      : shifts[parseInt(selectedMyShiftIndex, 10)] ?? null;

  // ---------- Trade candidates ----------

  const tradeCandidates: TradeCandidate[] = useMemo(() => {
    if (!myShift || !selectedDoctor) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const myOtherShifts = shifts.filter(
      (s) =>
        (s.doctor || "").trim().toLowerCase() ===
          selectedDoctor.trim().toLowerCase() && s !== myShift
    );

    const candidates: TradeCandidate[] = [];

    for (const s of shifts) {
      if (s === myShift) continue;

      const doc = (s.doctor || "").trim();
      if (!doc) continue; // no doctor -> not tradable
      if (doc.toLowerCase() === selectedDoctor.trim().toLowerCase())
        continue; // can't trade with yourself

      const d = new Date(s.date + "T00:00:00");
      if (d < today) continue; // only future

      // Remove options where user is already working an overlapping shift
      let overlapsMe = false;
      for (const mine of myOtherShifts) {
        if (shiftsOverlap(s, mine)) {
          overlapsMe = true;
          break;
        }
      }
      if (overlapsMe) continue;

      // Short-turnaround checks (similar to Same-Day mode)
      const { start: candStart } = getShiftDateTimes(s);
      const { start: myStart } = getShiftDateTimes(myShift);

      let myShort = false;
      let theirShort = false;

      // Scenario A: YOU take THEIR shift – ignore your original myShift
      const myPrev = findPreviousShiftEnd(shifts, selectedDoctor, candStart, [
        myShift,
      ]);
      if (myPrev) {
        const gap = hoursDiff(candStart, myPrev);
        if (gap < 12) myShort = true;
      }

      // Scenario B: THEY take YOUR shift – ignore their original candidate shift
      const theirPrev = findPreviousShiftEnd(shifts, doc, myStart, [s]);
      if (theirPrev) {
        const gap = hoursDiff(myStart, theirPrev);
        if (gap < 12) theirShort = true;
      }

      const hasShort = myShort || theirShort;

      const { score, label } = computeSimilarity(myShift, s);

      candidates.push({
        candidate: s,
        similarityScore: score,
        similarityLabel: label,
        myShort,
        theirShort,
        hasShort,
      });
    }

    // Sort:
    // 1) Non–short-turnaround trades first
    // 2) Higher similarity score
    // 3) Earlier date, then earlier start time
    candidates.sort((a, b) => {
      if (a.hasShort !== b.hasShort) {
        return a.hasShort ? 1 : -1; // false (0) first
      }
      if (b.similarityScore !== a.similarityScore) {
        return b.similarityScore - a.similarityScore; // higher score first
      }
      const d = a.candidate.date.localeCompare(b.candidate.date);
      if (d !== 0) return d;
      return a.candidate.startTime.localeCompare(b.candidate.startTime);
    });

    return candidates;
  }, [myShift, selectedDoctor, shifts]);

  // ---------- Render ----------

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "1rem" }}>
      <h1>Trade Fishing (Marketplace Prototype)</h1>
      <p style={{ marginBottom: "0.75rem" }}>
        Upload your MetricAid <code>.xlsx</code> export (the one that includes
        your own schedule + marketplace). Then pick{" "}
        <strong>your name</strong> and the shift you&apos;re trying to get rid
        of. I&apos;ll suggest marketplace shifts that are good trade targets,
        filter out overlaps, and flag short-turnaround risks.
      </p>

      {/* Step 1: Choose your name */}
      <section
        style={{
          border: "1px solid #ddd",
          padding: "0.75rem",
          borderRadius: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>1. Pick your name</h2>
        {doctors.length === 0 && (
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            Upload an <code>.xlsx</code> file first to see the doctor list.
          </p>
        )}
        {doctors.length > 0 && (
          <select
            value={selectedDoctor}
            onChange={(e) => setSelectedDoctor(e.target.value)}
            style={{ width: "100%", padding: "0.5rem", marginBottom: "0.75rem" }}
          >
            <option value="">-- Choose your name --</option>
            {doctors.map((doc) => (
              <option key={doc} value={doc}>
                {doc}
              </option>
            ))}
          </select>
        )}

        {/* Contact registration (optional, local only) */}
        {selectedDoctor && (
          <>
            <h3>Contact info for Trade Fishing (optional)</h3>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
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
                    setContactDraft((c) => ({ ...c, email: e.target.value }))
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
                    setContactDraft((c) => ({ ...c, phone: e.target.value }))
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
                  name="preferred-tf"
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
                  name="preferred-tf"
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
                  name="preferred-tf"
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
                  name="preferred-tf"
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
            <p style={{ fontSize: "0.8rem", color: "#555" }}>
              By entering my email and/or phone number and clicking Save, I
              consent to this site storing my contact information on this
              device so I can use it while fishing for trades.
            </p>
          </>
        )}
      </section>

      {/* Step 2: Upload XLSX */}
      <section
        style={{
          border: "1px solid #ddd",
          padding: "0.75rem",
          borderRadius: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>2. Upload your MetricAid .xlsx</h2>
        <div style={{ margin: "0.5rem 0" }}>
          <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} />
        </div>
        {fileName && (
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            Loaded file: <strong>{fileName}</strong>
          </p>
        )}
        {loading && <p>Reading and parsing XLSX…</p>}
        {error && <p style={{ color: "red" }}>{error}</p>}
        {shifts.length > 0 && !error && (
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            Parsed <strong>{shifts.length}</strong> total shifts (including your
            own + marketplace).
          </p>
        )}
      </section>

      {/* Step 3: Pick the shift you're trying to give away */}
      <section
        style={{
          border: "1px solid #ddd",
          padding: "0.75rem",
          borderRadius: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>3. Pick the shift you&apos;re fishing with</h2>
        {!selectedDoctor && (
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            Choose your name in step 1 first.
          </p>
        )}
        {selectedDoctor && myFutureShifts.length === 0 && (
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            No future shifts found for {selectedDoctor} in this file.
          </p>
        )}
        {selectedDoctor && myFutureShifts.length > 0 && (
          <select
            value={selectedMyShiftIndex}
            onChange={(e) => setSelectedMyShiftIndex(e.target.value)}
            style={{ width: "100%", padding: "0.5rem" }}
          >
            <option value="">-- Choose one of your future shifts --</option>
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
        )}
      </section>

      {/* Step 4: Trade Fishing results */}
      <section
        style={{
          border: "1px solid #ddd",
          padding: "0.75rem",
          borderRadius: "0.5rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>4. Trade Fishing results</h2>

        {!myShift && (
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            Select one of your future shifts above to see trade suggestions.
          </p>
        )}

        {myShift && (
          <>
            <p style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
              <strong>Your chosen shift:</strong>{" "}
              {formatHumanDate(myShift.date)} – {myShift.shiftName}{" "}
              {myShift.startTime}–{myShift.endTime}
            </p>

            {tradeCandidates.length === 0 && (
              <p style={{ fontSize: "0.9rem", color: "#555" }}>
                No suitable marketplace shifts found (after removing overlaps and
                filtering for future dates).
              </p>
            )}

            {tradeCandidates.length > 0 && (
              <div style={{ overflowX: "auto", maxHeight: 500, overflowY: "auto" }}>
                <table
                  border={1}
                  cellPadding={4}
                  style={{ borderCollapse: "collapse", minWidth: 800 }}
                >
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Shift</th>
                      <th>Times</th>
                      <th>Doctor</th>
                      <th>Match quality</th>
                      <th>Turnaround risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tradeCandidates.map((t, i) => (
                      <tr key={i}>
                        <td>{formatHumanDate(t.candidate.date)}</td>
                        <td>{t.candidate.shiftName}</td>
                        <td>
                          {t.candidate.startTime}–{t.candidate.endTime}
                        </td>
                        <td>{t.candidate.doctor}</td>
                        <td style={{ fontSize: "0.8rem" }}>
                          {t.similarityLabel}
                        </td>
                        <td
                          style={{
                            color: t.hasShort ? "red" : "green",
                            fontSize: "0.85rem",
                          }}
                        >
                          {t.hasShort
                            ? `SHORT TURNAROUND ${
                                t.myShort ? "(for YOU) " : ""
                              }${t.theirShort ? "(for THEM)" : ""}`
                            : "OK (≥ 12h each)"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
