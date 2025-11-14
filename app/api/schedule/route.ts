import { NextResponse } from "next/server";

type Shift = {
  date: string;      // YYYY-MM-DD
  shiftName: string; // e.g. "R-PM2"
  startTime: string; // "15:30"
  endTime: string;   // "00:30"
  doctor: string;    // e.g. "Peters"
  location: string;  // e.g. "St. Boniface Hospital - Emergency Department"
  raw: string;       // full SUMMARY line
};

const ICS_URL = process.env.ICS_URL;

// Parse the ICS text into our Shift[] format
function parseIcs(ics: string): Shift[] {
  const events = ics.split("BEGIN:VEVENT").slice(1);
  const shifts: Shift[] = [];

  for (const event of events) {
    const lines = event.split(/\r?\n/);

    const dtstartLine = lines.find((l) => l.startsWith("DTSTART"));
    const summaryLine = lines.find((l) => l.startsWith("SUMMARY"));
    const locationLine = lines.find((l) => l.startsWith("LOCATION"));

    if (!dtstartLine || !summaryLine) continue;

    const dtMatch = dtstartLine.match(/(\d{4})(\d{2})(\d{2})/);
    if (!dtMatch) continue;
    const [, year, month, day] = dtMatch;
    const date = `${year}-${month}-${day}`;

    const summary = summaryLine.replace(/^SUMMARY:/, "").trim();
    const location = locationLine
      ? locationLine.replace(/^LOCATION:/, "").trim()
      : "";

    // SUMMARY pattern:
    // SBH - ED - R-PM2 - 15:30-00:30 - Peters (Day 2/2)
    const summaryMatch = summary.match(
      /SBH\s*-\s*ED\s*-\s*([^-\r\n]+?)\s*-\s*(\d{2}:\d{2})-(\d{2}:\d{2})\s*-\s*([^(\r\n]+)/
    );

    if (!summaryMatch) continue;

    const [, shiftName, startTime, endTime, doctor] = summaryMatch;

    shifts.push({
      date,
      shiftName: shiftName.trim(),
      startTime,
      endTime,
      doctor: doctor.trim(),
      location,
      raw: summary,
    });
  }

  return shifts;
}

export async function GET() {
  try {
    if (!ICS_URL) {
      console.error("ICS_URL is not set in environment variables.");
      return NextResponse.json(
        { error: "ICS_URL not configured" },
        { status: 500 }
      );
    }

    const res = await fetch(ICS_URL, { cache: "no-store" });
    if (!res.ok) {
      console.error("Failed to fetch ICS:", res.status, res.statusText);
      return NextResponse.json(
        { error: "Failed to fetch ICS", status: res.status },
        { status: 500 }
      );
    }

    const icsText = await res.text();
    const shifts = parseIcs(icsText);

    return NextResponse.json(shifts);
  } catch (err) {
    console.error("Error in /api/schedule:", err);
    return NextResponse.json(
      { error: "Failed to load schedule" },
      { status: 500 }
    );
  }
}
