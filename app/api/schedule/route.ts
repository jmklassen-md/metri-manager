// app/api/schedule/route.ts
import { NextResponse } from "next/server";

/**
 * This route fetches your MetricAid / Google Calendar ICS and converts it into
 * a JSON list of shifts:
 *
 *  [
 *    {
 *      date: "2025-11-17",
 *      shiftName: "Surge-AM",
 *      startTime: "08:00",
 *      endTime: "17:00",
 *      doctor: "Klassen",
 *      location: "St. Boniface Hospital - Emergency Department",
 *      raw: "SBH - ED - Surge-AM - 08:00-17:00 - Klassen"
 *    },
 *    ...
 *  ]
 *
 * Make sure you have an env var set in Vercel, e.g.
 *   CALENDAR_ICS_URL = <your ICS URL>
 * If you’re currently using a different env name, just change it below.
 */

const ICS_URL =
  process.env.ICS_URL ||
  process.env.CALENDAR_ICS_URL ||
  process.env.METRI_MANAGER_ICS_URL;

export async function GET() {
  try {
    if (!ICS_URL) {
      return NextResponse.json(
        { error: "ICS URL not configured (CALENDAR_ICS_URL or METRI_MANAGER_ICS_URL)." },
        { status: 500 }
      );
    }

    const res = await fetch(ICS_URL);
    if (!res.ok) {
      return NextResponse.json(
        { error: "Could not fetch ICS", status: res.status, statusText: res.statusText },
        { status: 500 }
      );
    }

    const ics = await res.text();

    // Split into VEVENT blocks
    const rawEvents = ics.split("BEGIN:VEVENT").slice(1);

    const shifts = rawEvents
      .map((block) => {
        // DTSTART gives us the date
        const dtStartMatch = block.match(/DTSTART(?:;[^:]+)?:([0-9]{8})T[0-9]{6}Z?/);
        const summaryMatch = block.match(/SUMMARY:(.+)/);

        if (!dtStartMatch || !summaryMatch) return null;

        const rawSummary = summaryMatch[1].trim();

        // Typical MetricAid summary:
        // "SBH - ED - Surge-AM - 08:00-17:00 - Klassen"
        const m = rawSummary.match(
          /SBH - ED - (.+?) - (\d{2}:\d{2})-(\d{2}:\d{2}) - (.+)/
        );

        if (!m) {
          // Not an ED shift (could be Time Off etc.) – skip quietly
          return null;
        }

        const [, shiftName, startTime, endTime, doctor] = m;

        const yyyymmdd = dtStartMatch[1]; // 20251117
        const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

        return {
          date,
          shiftName: shiftName.trim(),
          startTime,
          endTime,
          doctor: doctor.trim(),
          location: "St. Boniface Hospital - Emergency Department",
          raw: rawSummary,
        };
      })
      .filter((x): x is {
        date: string;
        shiftName: string;
        startTime: string;
        endTime: string;
        doctor: string;
        location: string;
        raw: string;
      } => x !== null)
      .sort((a, b) =>
        `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`)
      );

    return NextResponse.json(shifts);
  } catch (err: any) {
    console.error("Error in /api/schedule:", err);
    return NextResponse.json(
      { error: "Unexpected error parsing ICS" },
      { status: 500 }
    );
  }
}
