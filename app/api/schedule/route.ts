import { NextResponse } from "next/server";

type Shift = {
  date: string;      // YYYY-MM-DD
  shiftName: string; // e.g. "Surge AM", "R-N", "RAZ-PM"
  startTime: string; // "08:00"
  endTime: string;   // "17:00"
  doctor: string;
  location?: string;
  raw?: string;      // original SUMMARY line for debugging
};

const ICS_URL =
  process.env.ICS_URL ||
  "https://app.metricaid.com/sync/key/e0c26420-5788-47d5-a160-6d647d20ad0a?t=1762461578&a=shifts&b=true&c=true&d=true&e=true&f=true&g=false&h=true&j=234&i=false&sendEmail=true";

// ------------ ICS Parsing Helpers ------------------------------------------

function parseICSDateTime(value: string): Date {
  // value like: 20251117T153000Z or 20251117T153000
  const clean = value.replace("Z", "");
  const m = clean.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})?$/);
  if (!m) return new Date(NaN);
  const [, y, mo, d, h, mi, s = "00"] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s)
  );
}

function getProp(lines: string[], prefix: string): string {
  const line = lines.find((l) => l.startsWith(prefix));
  if (!line) return "";
  const idx = line.indexOf(":");
  if (idx === -1) return "";
  return line.slice(idx + 1).trim();
}

function parseSummary(summary: string): { shiftName: string; doctor: string } {
  // Example summary:
  // "SBH - ED - R-PM2 - 15:30-00:30 - Peters (Day 2/2)"
  // "SBH - ED - Surge-AM - 08:00-17:00 - Klassen"
  const parts = summary.split(" - ").map((p) => p.trim());
  let shiftName = summary.trim();
  let doctor = "";

  if (parts.length >= 5) {
    // [0]=SBH, [1]=ED, [2]=Shift name, [3]=time block, [4]=Doctor (+ maybe Day info)
    shiftName = parts[2];
    doctor = parts[4].replace(/\(Day.*\)/, "").trim();
  } else if (parts.length >= 2) {
    // Fallback: take second last as shift, last as doctor
    shiftName = parts[parts.length - 2];
    doctor = parts[parts.length - 1].replace(/\(Day.*\)/, "").trim();
  }

  return { shiftName, doctor };
}

function parseICSText(text: string): Shift[] {
  const events: Shift[] = [];

  const chunks = text.split("BEGIN:VEVENT").slice(1); // drop header chunk

  for (const chunk of chunks) {
    const block = "BEGIN:VEVENT" + chunk;
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("BEGIN:VEVENT") && !l.startsWith("END:VEVENT"));

    const dtStartLine = lines.find((l) => l.startsWith("DTSTART"));
    const dtEndLine = lines.find((l) => l.startsWith("DTEND"));
    const summary = getProp(lines, "SUMMARY");
    const location = getProp(lines, "LOCATION");

    if (!dtStartLine || !dtEndLine || !summary) continue;

    const startValue = dtStartLine.split(":").slice(-1)[0];
    const endValue = dtEndLine.split(":").slice(-1)[0];

    const startDate = parseICSDateTime(startValue);
    const endDate = parseICSDateTime(endValue);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) continue;

    // Use local time for date & HH:MM
    const dateISO = startDate.toISOString().slice(0, 10);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    const startTime = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;
    const endTime = `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}`;

    const { shiftName, doctor } = parseSummary(summary);

    events.push({
      date: dateISO,
      shiftName,
      startTime,
      endTime,
      doctor,
      location,
      raw: summary,
    });
  }

  return events;
}

// ------------ API Route -----------------------------------------------------

export async function GET() {
  try {
    const res = await fetch(ICS_URL, { cache: "no-store" });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Could not fetch ICS", status: res.status },
        { status: 500 }
      );
    }

    const text = await res.text();
    const shifts = parseICSText(text);

    return NextResponse.json(shifts, { status: 200 });
  } catch (err: any) {
    console.error("Error in /api/schedule:", err);
    return NextResponse.json(
      { error: "Failed to load schedule" },
      { status: 500 }
    );
  }
}
