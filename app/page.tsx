"use client";

import React, { useEffect, useMemo, useState } from "react";

// ---------- Types ----------

type Shift = {
  date: string; // "2025-11-17"
  shiftName: string;
  startTime: string; // "08:00"
  endTime: string;   // "17:00"
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

type Mode = "sameDay" | "getTogether" | "periHang";

type PeriSuggestion =
  | "Greasy breakfast?"
  | "Wanna grab a beer?"
  | "Late lunch?";

const CONTACTS_STORAGE_KEY = "metriManagerContacts";

const ACCESS_CODE = process.env.NEXT_PUBLIC_ACCESS_CODE?.trim() || "";
const ACCESS_STORAGE_KEY = "metri-manager-access-ok";

// Optional built-in seeds if you want defaults
const SEED_CONTACTS: Record<string, Contact> = {};

// ---------- Time helpers ----------

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

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function sameDate(a: Date, b: Date) {
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

// ---------- Peri-Shift classification ----------

function classifyPeriSuggestion(
  start: Date,
  end: Date
): PeriSuggestion | null {
  const endHour = end.getHours();
  const startHour = start.getHours();

  // Greasy breakfast: shifts ending between 05:00 and 10:00
  if (endHour >= 5 && endHour < 10) {
    return "Greasy breakfast?";
  }

  // Wanna grab a beer: ending after 14:00 or before 04:00
  if (endHour >= 14 || endHour < 4) {
    return "Wanna grab a beer?";
  }

  // Late lunch: shifts starting between 12:00 and 16:00
  if (startHour >= 12 && startHour < 16) {
    return "Late lunch?";
  }

  return null;
}

// ---------- Main component ----------

export default function Page() {
  const [mode, setMode] = useState<Mode>("sameDay");

  // --- Access Code State ---
  const [hasAccess, setHasAccess] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [accessError, setAccessError] = useState("");

  // Check if already unlocked on this device
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(ACCESS_STORAGE_KEY);
    if (stored === "yes") {
      setHasAccess(true);
    }
  }, []);

  const handleAccessSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const expected = ACCESS_CODE;

    // If no access code is configured, just let them in
    if (!expected) {
      setHasAccess(true);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ACCESS_STORAGE_KEY, "yes");
      }
      return;
    }

    if (codeInput.trim() === expected) {
      setHasAccess(true);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ACCESS_STORAGE_KEY, "yes");
      }
      setAccessError("");
    } else {
      setAccessError("Access code is incorrect. Please try again.");
    }
  };

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);

  // contacts from DB + localStorage
  const [contacts, setContacts] = useState<Record<string, Contact>>({});
  const [contactsLoaded, setContactsLoaded] = useState(false);

  // Same-Day Trades state
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedShiftIndex, setSelectedShiftIndex] = useState("");

  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });
  const [contactSavedMessage, setContactSavedMessage] = useState("");

  // Get-Together state
  const [groupDoctors, setGroupDoctors] = useState<string[]>([]);

  // Peri-Shift Hang state
  const [periDoctors, setPeriDoctors] = useState<string[]>([]);

  // ---------- Load schedule ----------

  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) {
          setError("Could not load schedule.");
          return;
        }

        const sorted = [...data].sort((a, b) =>
          `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`)
        );
        setShifts(sorted);
      })
      .catch(() => setError("Could not load schedule."));
  }, []);

  // ---------- Load contacts (DB + localStorage fallback) ----------

  useEffect(() => {
    async function loadContacts() {
      try {
        // 1) Try from API / Postgres
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

        // 2) Merge with any local storage entries + seeds
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

        setContacts({ ...SEED_CONTACTS, ...fromDb, ...fromLocal });
      } catch {
        // If API fails, fall back to localStorage + seeds
        try {
          const raw =
            typeof window !== "undefined"
              ? window.localStorage.getItem(CONTACTS_STORAGE_KEY)
              : null;
          const stored = raw ? (JSON.parse(raw) as Record<string, Contact>) : {};
          setContacts({ ...SEED_CONTACTS, ...stored });
        } catch {
          setContacts({ ...SEED_CONTACTS });
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

  // ---------- Doctors list ----------

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

  // When doctor changes, update contactDraft from "database"
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

  // ---------- Same-Day Trades: doctor’s future shifts ----------

  const doctorFutureShifts = useMemo(() => {
    if (!selectedDoctor) return [];

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
      });
  }, [selectedDoctor, shifts]);

  const myShift =
    selectedShiftIndex === "" ? null : shifts[parseInt(selectedShiftIndex, 10)];

  const sameDayShifts = useMemo(() => {
    if (!myShift) return [];
    return shifts.filter((s) => s.date === myShift.date);
  }, [myShift, shifts]);

  // Helper: previous shift end (used by Same-Day Trades)
  function findPreviousShiftEnd(
    allShifts: Shift[],
    doctor: string,
    referenceStart: Date,
    ignore: Shift[] = []
  ): Date | null {
    const ends: Date[] = [];
    for (const s of allShifts) {
      if (ignore.includes(s)) continue;
      if (s.doctor !== doctor) continue;
      const { end } = getShiftDateTimes(s);
      if (!isNaN(end.getTime()) && end < referenceStart) {
        ends.push(end);
      }
    }
    if (!ends.length) return null;
    ends.sort((a, b) => b.getTime() - a.getTime());
    return ends[0];
  }

  const tradeOptions = useMemo(() => {
    if (!myShift) return [];

    const { start: myStart } = getShiftDateTimes(myShift);
    const myDoctor = myShift.doctor;

    return sameDayShifts
      .filter((s) => s !== myShift)
      .map((candidate) => {
        const { start: theirStart } = getShiftDateTimes(candidate);

        let myShort = false;
        let theirShort = false;

        // YOU taking THEIR shift – ignore your original
        const myPrev = findPreviousShiftEnd(shifts, myDoctor, theirStart, [
          myShift,
        ]);
        if (myPrev) {
          const gap = hoursDiff(theirStart, myPrev);
          if (gap < 12) myShort = true;
        }

        // THEM taking YOUR shift – ignore their original
        const theirPrev = findPreviousShiftEnd(
          shifts,
          candidate.doctor,
          myStart,
          [candidate]
        );
        if (theirPrev) {
          const gap = hoursDiff(myStart, theirPrev);
          if (gap < 12) theirShort = true;
        }

        return {
          candidate,
          myShort,
          theirShort,
          hasShort: myShort || theirShort,
        };
      });
  }, [myShift, sameDayShifts, shifts]);

  const myContact: Contact | undefined =
    selectedDoctor && contacts[selectedDoctor]
      ? contacts[selectedDoctor]
      : undefined;

  const myEmail = myContact?.email || "";
  const myPhone = myContact?.phone || "";

  // ---------- Build messages & send (Same-Day Trades) ----------

  const buildOfferMessage = (candidate: Shift) => {
    if (!myShift) return "";

    const meName = selectedDoctor || "Unknown doctor";
    const meLabel = meName ? `Dr. ${meName}` : "Unknown doctor";

    const myShiftStr = `${myShift.date} ${myShift.shiftName} ${myShift.startTime}–${myShift.endTime}`;
    const theirShiftStr = `${candidate.date} ${candidate.shiftName} ${candidate.startTime}–${candidate.endTime}`;

    const contactBits = [myEmail, myPhone].filter(Boolean).join(" / ");
    const contactLine = contactBits
      ? `Please contact ${meLabel} at ${contactBits} if you're interested.`
      : `Please contact ${meLabel} if you're interested.`;

    return `You've got a SAME-DAY SHIFT TRADE OFFER from ${meLabel}!

${meLabel} would like to trade:

  THEIR shift: ${myShiftStr}
  FOR your shift: ${theirShiftStr}

${contactLine}

(Generated by the Metri-Manager – mode: Same-Day Trades.)`;
  };

  const handleSendEmailOffer = (candidate: Shift) => {
    if (!myShift) return;

    const message = buildOfferMessage(candidate);
    if (!message) return;

    const meName = selectedDoctor || "Unknown doctor";
    const meLabel = meName ? `Dr. ${meName}` : "Unknown doctor";
    const otherName = candidate.doctor;

    const otherContact = contacts[otherName];
    const otherEmail = otherContact?.email ?? "";
    const myEmailForSend = myEmail;

    if (otherContact) {
      if (otherContact.preferred === "sms") {
        const proceed = window.confirm(
          `Note: Dr. ${otherName} prefers SMS. Do you still want to start an email?`
        );
        if (!proceed) return;
      } else if (otherContact.preferred === "none") {
        const proceed = window.confirm(
          `Note: Dr. ${otherName} prefers not to share contact info.\n` +
            `You may want to coordinate in person or via internal messaging.\n\n` +
            `Do you still want to proceed with an email (if possible)?`
        );
        if (!proceed) return;
      }
    }

    if (otherEmail || myEmailForSend) {
      const to = otherEmail || myEmailForSend;
      const ccParam =
        otherEmail && myEmailForSend && otherEmail !== myEmailForSend
          ? `&cc=${encodeURIComponent(myEmailForSend)}`
          : "";
      const subject = encodeURIComponent(
        `SAME-DAY SHIFT TRADE OFFER from ${meLabel}`
      );
      const body = encodeURIComponent(message);
      const mailto = `mailto:${encodeURIComponent(
        to
      )}?subject=${subject}${ccParam}&body=${body}`;
      window.location.href = mailto;
    } else {
      if (navigator.clipboard) {
        navigator.clipboard
          .writeText(message)
          .then(() => {
            alert(
              "Trade offer text copied to clipboard.\nPaste it into an email."
            );
          })
          .catch(() => alert(message));
      } else {
        alert(message);
      }
    }
  };

  const handleSendSmsOffer = (candidate: Shift) => {
    if (!myShift) return;

    const message = buildOfferMessage(candidate);
    if (!message) return;

    const otherName = candidate.doctor;
    const otherContact = contacts[otherName];
    const otherPhone = otherContact?.phone ?? "";
    const myPhoneForSend = myPhone;

    if (otherContact) {
      if (otherContact.preferred === "email") {
        const proceed = window.confirm(
          `Note: Dr. ${otherName} prefers email. Do you still want to start an SMS?`
        );
        if (!proceed) return;
      } else if (otherContact.preferred === "none") {
        const proceed = window.confirm(
          `Note: Dr. ${otherName} prefers not to share contact info.\n` +
            `You may want to coordinate in person or via internal messaging.\n\n` +
            `Do you still want to proceed with SMS (if possible)?`
        );
        if (!proceed) return;
      }
    }

    if (otherPhone || myPhoneForSend) {
      const to = otherPhone || myPhoneForSend;
      const smsUrl = `sms:${encodeURIComponent(
        to
      )}?body=${encodeURIComponent(message)}`;
      window.location.href = smsUrl;
    } else {
      if (navigator.clipboard) {
        navigator.clipboard
          .writeText(message)
          .then(() => {
            alert(
              "Trade offer text copied to clipboard.\nPaste it into your SMS app."
            );
          })
          .catch(() => alert(message));
      } else {
        alert(message);
      }
    }
  };

  // Save contact info for selected doctor (DB + localStorage)
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

  const myPreferenceText = myContact
    ? formatPreference(myContact)
    : "No contact info saved for you yet.";

  // ---------- Get-Together logic ----------

  type GetTogetherDay = {
    date: string;
    warnings: string[];
  };

  const getTogetherDays: GetTogetherDay[] = useMemo(() => {
    if (!groupDoctors.length) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const relevant = shifts.filter((s) => groupDoctors.includes(s.doctor));

    if (!relevant.length) return [];

    const futureRelevant = relevant.filter((s) => {
      const d = new Date(s.date + "T00:00:00");
      return d >= today;
    });
    if (!futureRelevant.length) return [];

    let minDate = futureRelevant
      .map((s) => s.date)
      .reduce((a, b) => (a < b ? a : b));
    let maxDate = futureRelevant
      .map((s) => s.date)
      .reduce((a, b) => (a > b ? a : b));

    maxDate = addDays(maxDate, 3);

    const days: GetTogetherDay[] = [];

    for (let dStr = minDate; dStr <= maxDate; dStr = addDays(dStr, 1)) {
      const thisDate = new Date(dStr + "T00:00:00");
      if (thisDate < today) continue;

      const nextDateStr = addDays(dStr, 1);
      const prevDateStr = addDays(dStr, -1);

      const eveningStart = new Date(dStr + "T17:00:00");
      const eveningEnd = new Date(dStr + "T22:00:00");
      const preNightStart = new Date(dStr + "T22:00:00");
      const day10 = new Date(dStr + "T10:00:00");
      const day14 = new Date(dStr + "T14:00:00");
      const zero = new Date(dStr + "T00:00:00");
      const six = new Date(dStr + "T06:00:00");

      let blocked = false;
      const warnings: string[] = [];

      for (const doc of groupDoctors) {
        const sameDayShiftsForDoc = relevant.filter(
          (s) => s.doctor === doc && s.date === dStr
        );
        const prevDayShiftsForDoc = relevant.filter(
          (s) => s.doctor === doc && s.date === prevDateStr
        );

        // 1) Evening conflict (17:00–22:00) on this date
        for (const s of sameDayShiftsForDoc) {
          const { start, end } = getShiftDateTimes(s);
          const overlapsEvening =
            start < eveningEnd && end > eveningStart;
          const isPreNightStart = start >= preNightStart;
          // We allow pure pre-night (start ≥ 22:00) – only warn, not block.
          if (overlapsEvening && !isPreNightStart) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;

        // 2) Pre-nights on this date (start ≥ 22:00)
        for (const s of sameDayShiftsForDoc) {
          const { start } = getShiftDateTimes(s);
          const startsLate =
            sameDate(start, thisDate) && start >= preNightStart;
          if (startsLate) {
            warnings.push(
              `⚠ Warning: ${doc} is pre-nights (${s.shiftName} on ${formatHumanDate(
                s.date
              )})`
            );
          }
        }

        // 3) Coming off days (worked between 10:00 and 14:00)
        for (const s of sameDayShiftsForDoc) {
          const { start, end } = getShiftDateTimes(s);
          const overlapsDay = start < day14 && end > day10;
          if (overlapsDay) {
            warnings.push(
              `⚠ Warning: ${doc} is coming off days (${s.shiftName} on ${formatHumanDate(
                s.date
              )})`
            );
          }
        }

        // 4) Post-nights: previous day shift starts ≥ 22:00 and overlaps 00–06
        for (const s of prevDayShiftsForDoc) {
          const { start, end } = getShiftDateTimes(s);
          const prevDay = new Date(prevDateStr + "T00:00:00");
          const startsPrevLate =
            sameDate(start, prevDay) && start.getHours() >= 22;
          const overlapsEarly = start < six && end > zero;
          if (startsPrevLate && overlapsEarly) {
            warnings.push(
              `⚠ Warning: ${doc} is post-nights (${s.shiftName} on ${formatHumanDate(
                s.date
              )})`
            );
          }
        }
      }

      if (!blocked) {
        days.push({ date: dStr, warnings });
      }
    }

    days.sort((a, b) => a.date.localeCompare(b.date));
    return days;
  }, [groupDoctors, shifts]);

  // ---------- Get-Together helpers: ICS + email ----------

  function buildGroupEmailForDate(date: string, warnings: string[]) {
    const dateLabel = formatHumanDate(date);
    const docList = groupDoctors.join(", ") || "group";
    let body = `Hi everyone,\n\nHere is a potential get-together evening for ${docList}:\n\n`;
    body += `  • ${dateLabel}\n\n`;
    if (warnings.length) {
      body += "Warnings:\n";
      for (const w of warnings) body += `  • ${w.replace(/^⚠ /, "")}\n`;
      body += "\n";
    }
    body +=
      "If this works for you, please reply-all.\n\n(Generated by Metri-Manager – mode: Get Together.)";
    return body;
  }

  function handleEmailDateToGroup(date: string, warnings: string[]) {
    const subject = encodeURIComponent(
      `Get-together evening option: ${formatHumanDate(date)}`
    );
    const body = encodeURIComponent(buildGroupEmailForDate(date, warnings));

    // Collect known emails for group
    const emails = groupDoctors
      .map((doc) => contacts[doc]?.email)
      .filter((e) => e && e.length > 0) as string[];

    const to = emails.join(",");
    const mailto = `mailto:${encodeURIComponent(
      to
    )}?subject=${subject}&body=${body}`;
    window.location.href = mailto;
  }

  function handleDownloadIcs(date: string) {
    const summary = "Get-together evening";
    const description = `Metri-Manager get-together for: ${groupDoctors.join(
      ", "
    )}`;
    const dtStart = date.replace(/-/g, "") + "T190000";
    const dtEnd = date.replace(/-/g, "") + "T210000";

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Metri-Manager//GetTogether//EN",
      "BEGIN:VEVENT",
      `UID:get-together-${date}@metri-manager`,
      `DTSTAMP:${dtStart}Z`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `get-together-${date}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- Peri-Shift Hang logic ----------

  type PeriHangEvent = {
    dateKey: string;
    dateLabel: string;
    timeLabel: string;
    kind: "start" | "end"; // cluster type
    participants: {
      doctor: string;
      shiftName: string;
      startTime: string;
      endTime: string;
      suggestion: PeriSuggestion | null;
    }[];
  };

  const periHangEvents: PeriHangEvent[] = useMemo(() => {
    if (periDoctors.length < 2 || shifts.length === 0) return [];

    const now = new Date();
    now.setSeconds(0, 0);

    // Only consider shifts for the selected doctors, with future (or ongoing) end times
    const relevant = shifts.filter((s) => {
      const doc = (s.doctor || "").trim();
      if (!periDoctors.includes(doc)) return false;
      const { start, end } = getShiftDateTimes(s);
      return !isNaN(start.getTime()) && end >= now;
    });

    if (relevant.length === 0) return [];

    type Node = {
      doctor: string;
      shift: Shift;
      when: Date; // either start or end
      kind: "start" | "end";
    };

    const nodes: Node[] = [];
    for (const s of relevant) {
      const { start, end } = getShiftDateTimes(s);
      if (!isNaN(start.getTime())) {
        nodes.push({ doctor: s.doctor, shift: s, when: start, kind: "start" });
      }
      if (!isNaN(end.getTime())) {
        nodes.push({ doctor: s.doctor, shift: s, when: end, kind: "end" });
      }
    }

    const MAX_DIFF_MS = 45 * 60 * 1000; // 45 minutes
    const seen = new Set<string>();
    const events: PeriHangEvent[] = [];

    function buildClusters(kind: "start" | "end") {
      const list = nodes
        .filter((n) => n.kind === kind)
        .sort((a, b) => a.when.getTime() - b.when.getTime());

      let left = 0;
      for (let right = 0; right < list.length; right++) {
        // Maintain a window where max(time) - min(time) <= 45min
        while (
          list[right].when.getTime() - list[left].when.getTime() >
          MAX_DIFF_MS
        ) {
          left++;
        }

        const windowNodes = list.slice(left, right + 1);
        if (windowNodes.length < 2) continue;

        // Group by doctor, keep earliest event per doctor in this window
        const byDoctor = new Map<string, Node>();
        for (const n of windowNodes) {
          const existing = byDoctor.get(n.doctor);
          if (!existing || n.when < existing.when) {
            byDoctor.set(n.doctor, n);
          }
        }

        if (byDoctor.size < 2) continue;

        const participantsNodes = Array.from(byDoctor.values());
        const docsSorted = Array.from(byDoctor.keys()).sort();

        const times = participantsNodes.map((n) => n.when.getTime());
        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);

        // Safety: ensure *all* are within 45 minutes of each other
        if (maxTime - minTime > MAX_DIFF_MS) continue;

        const key = `${kind}|${docsSorted.join(",")}|${minTime}|${maxTime}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const rep = new Date(minTime);
        const timeLabel = rep.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        });

        const y = rep.getFullYear();
        const m = rep.getMonth() + 1;
        const d = rep.getDate();
        const dateKey = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(
          2,
          "0"
        )}`;
        const dateLabel = rep.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        });

        const participants = participantsNodes.map((n) => {
          const { start, end } = getShiftDateTimes(n.shift);
          return {
            doctor: n.doctor,
            shiftName: n.shift.shiftName,
            startTime: n.shift.startTime,
            endTime: n.shift.endTime,
            suggestion: classifyPeriSuggestion(start, end),
          };
        });

        events.push({
          dateKey,
          dateLabel,
          timeLabel,
          kind,
          participants,
        });
      }
    }

    // Build clusters separately for starts and ends
    buildClusters("start");
    buildClusters("end");

    events.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    return events;
  }, [periDoctors, shifts]);

  // ---------- Peri-Shift Hang helpers: email / SMS ----------

  function buildPeriEmailBody(event: PeriHangEvent): string {
    const who = event.participants.map((p) => p.doctor).join(", ");
    const introKind =
      event.kind === "start"
        ? "starting shifts around"
        : "finishing shifts around";

    let body = `Hi everyone,\n\nWe found a peri-shift hang opportunity for ${who}:\n\n`;
    body += `  • ${event.dateLabel}, ${introKind} ${event.timeLabel}\n\n`;
    body += "Details:\n";
    for (const p of event.participants) {
      const suggestionText = p.suggestion ? ` – ${p.suggestion}` : "";
      body += `  • Dr. ${p.doctor}: ${p.shiftName} ${p.startTime}–${p.endTime}${suggestionText}\n`;
    }
    body +=
      "\nIf this works for you, please reply-all.\n\n(Generated by Metri-Manager – mode: Peri-Shift Hang.)";
    return body;
  }

  function handleEmailPeriEvent(event: PeriHangEvent) {
    const subject = encodeURIComponent(
      `Peri-shift hang option: ${event.dateLabel} (${event.timeLabel})`
    );
    const body = encodeURIComponent(buildPeriEmailBody(event));

    const emails = event.participants
      .map((p) => contacts[p.doctor]?.email)
      .filter((e) => e && e.length > 0) as string[];

    const to = emails.join(",");
    const mailto = `mailto:${encodeURIComponent(
      to
    )}?subject=${subject}&body=${body}`;
    window.location.href = mailto;
  }

  function handleCopyPeriSms(event: PeriHangEvent) {
    const body = buildPeriEmailBody(event);
    const smsText =
      body +
      "\n\n(Copy/paste this into a group text or WhatsApp chat.)";

    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(smsText)
        .then(() => {
          alert(
            "Peri-shift hang text copied to clipboard.\nPaste it into your SMS or group chat."
          );
        })
        .catch(() => alert(smsText));
    } else {
      alert(smsText);
    }
  }

  // ---------- ACCESS GATE ----------

  if (!hasAccess) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#101827",
          color: "#f9fafb",
          padding: "1rem",
        }}
      >
        <div
          style={{
            maxWidth: 400,
            width: "100%",
            padding: "1.5rem",
            borderRadius: 12,
            background: "#111827",
            boxShadow: "0 10px 25px rgba(0,0,0,0.4)",
            border: "1px solid #374151",
          }}
        >
          <h1 style={{ marginBottom: "0.5rem" }}>Metri-Manager</h1>
          <p
            style={{
              fontSize: "0.9rem",
              color: "#9ca3af",
              marginBottom: "1rem",
            }}
          >
            Please enter the SBH access code to continue.
          </p>

          <form onSubmit={handleAccessSubmit}>
            <input
              type="password"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="Access code"
              style={{
                width: "100%",
                padding: "0.6rem 0.8rem",
                borderRadius: 6,
                border: "1px solid #4b5563",
                background: "#020617",
                color: "#f9fafb",
                marginBottom: "0.75rem",
              }}
            />
            {accessError && (
              <div
                style={{
                  color: "#fca5a5",
                  marginBottom: "0.75rem",
                  fontSize: "0.85rem",
                }}
              >
                {accessError}
              </div>
            )}
            <button
              type="submit"
              style={{
                width: "100%",
                padding: "0.6rem 0.8rem",
                borderRadius: 6,
                border: "none",
                background: "#2563eb",
                color: "white",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Enter
            </button>
          </form>

          <p
            style={{
              marginTop: "0.75rem",
              fontSize: "0.75rem",
              color: "#6b7280",
            }}
          >
            For SBH Emergency Department staff only.
          </p>
        </div>
      </main>
    );
  }

  // ---------- MAIN RENDER ----------

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "1rem" }}>
      <h1>Metri-Manager</h1>
      <p style={{ marginBottom: "1rem" }}>
        SBH Shift Helper – Same-Day Trades, Get Together planning, and
        Peri-Shift Hang.
      </p>

      {/* Mode toggle */}
      <div style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          onClick={() => setMode("sameDay")}
          style={{
            padding: "0.5rem 1rem",
            marginRight: "0.5rem",
            borderRadius: "999px",
            border: "1px solid #333",
            background: mode === "sameDay" ? "#1d4ed8" : "#fff",
            color: mode === "sameDay" ? "#fff" : "#000",
          }}
        >
          Same-Day Trades
        </button>
        <button
          type="button"
          onClick={() => setMode("getTogether")}
          style={{
            padding: "0.5rem 1rem",
            marginRight: "0.5rem",
            borderRadius: "999px",
            border: "1px solid #333",
            background: mode === "getTogether" ? "#1d4ed8" : "#fff",
            color: mode === "getTogether" ? "#fff" : "#000",
          }}
        >
          Get Together
        </button>
        <button
          type="button"
          onClick={() => setMode("periHang")}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: "999px",
            border: "1px solid #333",
            background: mode === "periHang" ? "#1d4ed8" : "#fff",
            color: mode === "periHang" ? "#fff" : "#000",
          }}
        >
          Peri-Shift Hang
        </button>
      </div>

      {error && <p style={{ color: "red" }}>{error}</p>}

      {/* ---------------- SAME-DAY TRADES ---------------- */}
      {mode === "sameDay" && (
        <section
          style={{
            border: "1px solid #ccc",
            padding: "1rem",
            borderRadius: "0.5rem",
          }}
        >
          <h2>Same-Day Trades</h2>
          <p>
            Choose your name, then one of your <strong>future</strong> shifts.
            I’ll list all other shifts on that same day and flag any trades that
            would create a short turnaround (&lt; 12 hours between shifts for
            either doctor).
          </p>

          <hr />

          {/* Doctor dropdown */}
          <h3>1. Pick your name</h3>
          {doctors.length === 0 && !error && <p>Loading…</p>}
          {doctors.length > 0 && (
            <select
              value={selectedDoctor}
              onChange={(e) => {
                setSelectedDoctor(e.target.value);
                setSelectedShiftIndex("");
              }}
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

          {/* Contact registration */}
          {selectedDoctor && (
            <>
              <hr />
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
                    By entering my email and/or phone number and clicking Save,
                    I consent to this site storing my contact information so
                    that other users can contact me for shift trades.
                  </p>
                </>
              )}
            </>
          )}

          <hr />

          {/* Shift dropdown */}
          <h3>2. Pick one of your future shifts</h3>
          {!selectedDoctor && <p>Select your name first.</p>}

          {selectedDoctor && doctorFutureShifts.length === 0 && (
            <p>No future shifts found for {selectedDoctor}.</p>
          )}

          {selectedDoctor && doctorFutureShifts.length > 0 && (
            <select
              value={selectedShiftIndex}
              onChange={(e) => setSelectedShiftIndex(e.target.value)}
              style={{ width: "100%", padding: "0.5rem" }}
            >
              <option value="">-- Choose a shift --</option>
              {doctorFutureShifts.map(({ s, index }) => {
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

          <hr />

          <h3>Shifts on that day</h3>
          {!myShift && <p>Choose one of your shifts above.</p>}
          {myShift && (
            <>
              <p>
                <strong>Your shift:</strong> {formatHumanDate(myShift.date)}{" "}
                {myShift.shiftName} ({myShift.startTime}–{myShift.endTime})
              </p>
              <div style={{ overflowX: "auto" }}>
                <table
                  border={1}
                  cellPadding={4}
                  style={{ borderCollapse: "collapse", minWidth: 400 }}
                >
                  <thead>
                    <tr>
                      <th>Shift</th>
                      <th>Doctor</th>
                      <th>Start</th>
                      <th>End</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sameDayShifts.map((s, i) => (
                      <tr key={i}>
                        <td>{s.shiftName}</td>
                        <td>{s.doctor}</td>
                        <td>{s.startTime}</td>
                        <td>{s.endTime}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <hr />

          <h3>Trade analysis</h3>
          {!myShift && (
            <p>Select a shift above to see potential trade risks.</p>
          )}

          {myShift && tradeOptions.length === 0 && (
            <p>No other shifts on that day.</p>
          )}

          {myShift && tradeOptions.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table
                border={1}
                cellPadding={4}
                style={{ borderCollapse: "collapse", minWidth: 650 }}
              >
                <thead>
                  <tr>
                    <th>Candidate Shift</th>
                    <th>Doctor</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Contact preference</th>
                    <th>Turnaround Risk</th>
                    <th>Send offer</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeOptions.map((t, i) => {
                    const otherContact = contacts[t.candidate.doctor];
                    const prefText = formatPreference(otherContact);
                    return (
                      <tr key={i}>
                        <td>{t.candidate.shiftName}</td>
                        <td>{t.candidate.doctor}</td>
                        <td>{t.candidate.startTime}</td>
                        <td>{t.candidate.endTime}</td>
                        <td>{prefText}</td>
                        <td style={{ color: t.hasShort ? "red" : "green" }}>
                          {t.hasShort
                            ? `SHORT TURNAROUND ${
                                t.myShort ? "(for YOU) " : ""
                              }${t.theirShort ? "(for THEM)" : ""}`
                            : "OK (≥ 12h each)"}
                        </td>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.25rem",
                            }}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                handleSendEmailOffer(t.candidate)
                              }
                              style={{ padding: "0.25rem 0.5rem" }}
                            >
                              Email / copy
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleSendSmsOffer(t.candidate)
                              }
                              style={{ padding: "0.25rem 0.5rem" }}
                            >
                              SMS / copy
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ---------------- GET TOGETHER ---------------- */}
      {mode === "getTogether" && (
        <section
          style={{
            border: "1px solid #ccc",
            padding: "1rem",
            borderRadius: "0.5rem",
          }}
        >
          <h2>Get Together – Free Evenings After 17:00</h2>
          <p>
            Select doctors below. I’ll show <strong>future dates</strong> where
            all of them are free after 17:00. If someone is pre-nights
            (22:00–24:00), coming off days (10:00–14:00), or post-nights (night
            that ended between 00:00 and 06:00), I’ll flag it with a warning.
          </p>

          <h3>Select doctors</h3>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
              marginBottom: "1rem",
            }}
          >
            {doctors.map((doc) => {
              const selected = groupDoctors.includes(doc);
              return (
                <button
                  key={doc}
                  type="button"
                  onClick={() =>
                    setGroupDoctors((prev) =>
                      prev.includes(doc)
                        ? prev.filter((d) => d !== doc)
                        : [...prev, doc]
                    )
                  }
                  style={{
                    padding: "0.25rem 0.75rem",
                    borderRadius: "999px",
                    border: "1px solid #333",
                    background: selected ? "#1d4ed8" : "#fff",
                    color: selected ? "#fff" : "#000",
                    fontSize: "0.9rem",
                  }}
                >
                  {selected ? "✓ " : ""}
                  {doc}
                </button>
              );
            })}
          </div>

          {groupDoctors.length === 0 && (
            <p>Select one or more doctors to see potential evenings.</p>
          )}

          {groupDoctors.length > 0 && getTogetherDays.length === 0 && (
            <p>No suitable future evenings found in the schedule.</p>
          )}

          {groupDoctors.length > 0 && getTogetherDays.length > 0 && (
            <>
              <h3>Potential Get-Together Evenings</h3>
              {getTogetherDays.map((d) => (
                <div
                  key={d.date}
                  style={{
                    borderTop: "1px solid #eee",
                    paddingTop: "0.5rem",
                    marginTop: "0.5rem",
                  }}
                >
                  <strong>{formatHumanDate(d.date)}</strong>
                  <div style={{ marginTop: "0.25rem" }}>
                    {d.warnings.map((w, i) => (
                      <div
                        key={i}
                        style={{ color: "#b45309", fontSize: "0.9rem" }}
                      >
                        {w}
                      </div>
                    ))}
                    {d.warnings.length === 0 && (
                      <div style={{ fontSize: "0.9rem", color: "#16a34a" }}>
                        No warnings.
                      </div>
                    )}
                  </div>
                  <div style={{ marginTop: "0.25rem" }}>
                    <button
                      type="button"
                      onClick={() => handleDownloadIcs(d.date)}
                      style={{ marginRight: "0.5rem" }}
                    >
                      Download .ics
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        handleEmailDateToGroup(d.date, d.warnings)
                      }
                    >
                      Email this date to group
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </section>
      )}

      {/* ---------------- PERI-SHIFT HANG ---------------- */}
      {mode === "periHang" && (
        <section
          style={{
            border: "1px solid #ccc",
            padding: "1rem",
            borderRadius: "0.5rem",
          }}
        >
          <h2>Peri-Shift Hang</h2>
          <p>
            Select a group of doctors. I’ll find <strong>future</strong>{" "}
            incidents where everyone in the group is{" "}
            <strong>starting</strong> a shift within 45 minutes of each other
            (start–start clusters) or <strong>ending</strong> a shift within 45
            minutes of each other (end–end clusters).
          </p>
          <p>
            I’ll also label events as <em>Greasy breakfast?</em>,{" "}
            <em>Wanna grab a beer?</em>, or <em>Late lunch?</em> based on shift
            times.
          </p>

          <h3>Select doctors</h3>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
              marginBottom: "1rem",
            }}
          >
            {doctors.map((doc) => {
              const selected = periDoctors.includes(doc);
              return (
                <button
                  key={doc}
                  type="button"
                  onClick={() =>
                    setPeriDoctors((prev) =>
                      prev.includes(doc)
                        ? prev.filter((d) => d !== doc)
                        : [...prev, doc]
                    )
                  }
                  style={{
                    padding: "0.25rem 0.75rem",
                    borderRadius: "999px",
                    border: "1px solid #333",
                    background: selected ? "#1d4ed8" : "#fff",
                    color: selected ? "#fff" : "#000",
                    fontSize: "0.9rem",
                  }}
                >
                  {selected ? "✓ " : ""}
                  {doc}
                </button>
              );
            })}
          </div>

          {periDoctors.length === 0 && (
            <p>Select at least two doctors to look for peri-shift hangs.</p>
          )}

          {periDoctors.length > 0 && periHangEvents.length === 0 && (
            <p>No peri-shift hang opportunities found in the future schedule.</p>
          )}

          {periDoctors.length > 0 && periHangEvents.length > 0 && (
            <>
              <h3>Peri-Shift Hang Opportunities</h3>
              {periHangEvents.map((evt, idx) => (
                <div
                  key={`${evt.dateKey}-${idx}`}
                  style={{
                    borderTop: "1px solid #eee",
                    paddingTop: "0.5rem",
                    marginTop: "0.5rem",
                  }}
                >
                  <strong>{evt.dateLabel}</strong>{" "}
                  <span style={{ fontSize: "0.9rem", color: "#555" }}>
                    – {evt.kind === "start" ? "Starting around" : "Ending around"}{" "}
                    {evt.timeLabel}
                  </span>
                  <ul style={{ marginTop: "0.25rem", paddingLeft: "1.25rem" }}>
                    {evt.participants.map((p, i) => (
                      <li key={i} style={{ fontSize: "0.9rem" }}>
                        Dr. {p.doctor}: {p.shiftName} {p.startTime}–{p.endTime}
                        {p.suggestion ? ` – ${p.suggestion}` : ""}
                      </li>
                    ))}
                  </ul>
                  <div style={{ marginTop: "0.25rem" }}>
                    <button
                      type="button"
                      onClick={() => handleEmailPeriEvent(evt)}
                      style={{ marginRight: "0.5rem" }}
                    >
                      Email this hang to group
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopyPeriSms(evt)}
                    >
                      Copy text for SMS / chat
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </section>
      )}
    </main>
  );
}
