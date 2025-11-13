import { NextResponse } from "next/server";

const ICS_URL =
  "https://calendar.google.com/calendar/ical/9lkc6l8fb3onolrf1fv25juk2uk1jd76%40import.calendar.google.com/public/basic.ics";

function parseICS(icsText: string) {
  const events: Record<string, string>[] = [];
  const lines = icsText.split(/\r?\n/);
  let current: Record<string, string> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
    } else if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
    } else if (current) {
      const idx = line.indexOf(":");
      if (idx > -1) {
        const key = line.slice(0, idx);
        const val = line.slice(idx + 1);
        current[key] = val;
      }
    }
  }
  return events;
}

function parseSummary(summary: string) {
  const parts = summary.split(" - ").map((p) => p.trim());
  let shiftName = "";
  let doctor = "";

  if (parts.length >= 3) {
    shiftName = parts[2];
  } else {
    shiftName = summary.trim();
  }

  if (parts.length >= 5) {
    doctor = parts[4].replace(/\(.*?\)\s*$/, "").trim();
  }

  return { shiftName, doctor };
}

function parseICSDate(ics: string): Date | null {
  if (!ics) return null;

  if (ics.endsWith("Z")) {
    const iso =
      ics.slice(0, 4) +
      "-" +
      ics.slice(4, 6) +
      "-" +
      ics.slice(6, 8) +
      "T" +
      ics.slice(9, 11) +
      ":" +
      ics.slice(11, 13) +
      ":" +
      ics.slice(13, 15) +
      "Z";
    return new Date(iso);
  }

  if (ics.includes("T")) {
    const y = ics.slice(0, 4);
    const m = ics.slice(4, 6);
    const d = ics.slice(6, 8);
    const hh = ics.slice(9, 11);
    const mm = ics.slice(11, 13);
    const ss = ics.slice(13, 15) || "00";
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  }

  if (ics.length === 8) {
    const y = ics.slice(0, 4);
    const m = ics.slice(4, 6);
    const d = ics.slice(6, 8);
    return new Date(`${y}-${m}-${d}T00:00:00`);
  }

  return null;
}

function formatDateLocal(date: Date, timeZone = "America/Winnipeg") {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  const parts = new Intl.DateTimeFormat("en-CA", opts)
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {} as Record<string, string>);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTimeLocal(date: Date, timeZone = "America/Winnipeg") {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  return new Intl.DateTimeFormat("en-CA", opts).format(date);
}

export async function GET() {
  const res = await fetch(ICS_URL, { cache: "no-store" });
  if (!res.ok) {
    return NextResponse.json(
      { error: "Could not fetch Google Calendar ICS" },
      { status: 500 }
    );
  }

  const icsText = await res.text();
  const events = parseICS(icsText);

  const normalized = events.map((ev) => {
    const dtStartRaw =
      ev["DTSTART"] ||
      ev["DTSTART;VALUE=DATE"] ||
      ev["DTSTART;TZID=America/Chicago"] ||
      ev["DTSTART;TZID=America/Winnipeg"];
    const dtEndRaw =
      ev["DTEND"] ||
      ev["DTEND;VALUE=DATE"] ||
      ev["DTEND;TZID=America/Chicago"] ||
      ev["DTEND;TZID=America/Winnipeg"];

    const startDate = dtStartRaw ? parseICSDate(dtStartRaw) : null;
    const endDate = dtEndRaw ? parseICSDate(dtEndRaw) : null;

    const summary = ev["SUMMARY"] || "";
    const location = ev["LOCATION"] || "";
    const { shiftName, doctor } = parseSummary(summary);

    return {
      date: startDate ? formatDateLocal(startDate) : "",
      shiftName,
      startTime: startDate ? formatTimeLocal(startDate) : "",
      endTime: endDate ? formatTimeLocal(endDate) : "",
      doctor,
      location,
      raw: summary,
    };
  });

  return NextResponse.json(normalized);
}
