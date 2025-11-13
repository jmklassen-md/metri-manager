"use client";

import React, { useEffect, useMemo, useState } from "react";

type Shift = {
  date: string;       // YYYY-MM-DD
  shiftName: string;  // e.g. SBH - ED - R-PM2 - 15:30-00:30 - Peters (Day 2/2)
  startTime: string;  // HH:MM 24h local
  endTime: string;    // HH:MM 24h local
  doctor: string;
  location?: string;
  raw?: string;
};

// ---- time helpers ---------------------------------------------------------

function toDateTime(date: string, time: string): Date {
  if (!date || !time) return new Date(NaN);
  return new Date(`${date}T${time}:00`);
}

function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = toDateTime(shift.date, shift.startTime);
  let end = toDateTime(shift.date, shift.endTime);

  // Handle overnight shifts (end earlier than start -> next day)
  if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return { start, end };
}

function hoursDiff(later: Date, earlier: Date) {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60);
}

function findPreviousShiftEnd(
  allShifts: Shift[],
  doctor: string,
  referenceStart: Date
): Date | null {
  const ends: Date[] = [];

  for (const s of allShifts) {
    if (s.doctor !== doctor) continue;
    const { end } = getShiftDateTimes(s);
    if (!isNaN(end.getTime()) && end < referenceStart) {
      ends.push(end);
    }
  }

  if (!ends.length) return null;
  ends.sort((a, b) => b.getTime() - a.getTime()); // most recent first
  return ends[0];
}

// ---- main component -------------------------------------------------------

export default function Page() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<string>("");

  // Load all shifts from API
  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) {
          console.error("API did not return an array:", data);
          setError("Could not load schedule from calendar.");
          return;
        }
        // Sort by date + start time
        const sorted = [...data].sort((a, b) => {
          const keyA = `${a.date} ${a.startTime}`;
          const keyB = `${b.date} ${b.startTime}`;
          return keyA.localeCompare(keyB);
        });
        setShifts(sorted);
      })
      .catch((e) => {
        console.error(e);
        setError("Could not load schedule from calendar.");
      });
  }, []);

  const myShift =
    selectedIndex === "" ? null : shifts[parseInt(selectedIndex, 10)];

  const sameDayShifts = useMemo(() => {
    if (!myShift) return [];
    return shifts.filter((s) => s.date === myShift.date);
  }, [myShift, shifts]);

  const tradeOptions = useMemo(() => {
    if (!myShift) return [];

    const { start: myStart } = getShiftDateTimes(myShift);
    const myDoctor = myShift.doctor;

    return sameDayShifts
      .filter((s) => s !== myShift)
      .map((candidate) => {
        const { start: theirStart } = getShiftDateTimes(candidate);
        const theirDoctor = candidate.doctor;

        let myShort = false;
        let theirShort = false;

        // If I take THEIR shift: look at my previous end → theirStart
        if (myDoctor && !isNaN(theirStart.getTime())) {
          const prevEnd = findPreviousShiftEnd(shifts, myDoctor, theirStart);
          if (prevEnd) {
            const gap = hoursDiff(theirStart, prevEnd);
            if (gap < 12) myShort = true;
          }
        }

        // If THEY take MY shift: look at their previous end → myStart
        if (theirDoctor && !isNaN(myStart.getTime())) {
          const prevEnd = findPreviousShiftEnd(
            shifts,
            theirDoctor,
            myStart
          );
          if (prevEnd) {
            const gap = hoursDiff(myStart, prevEnd);
            if (gap < 12) theirShort = true;
          }
        }

        return {
          candidate,
          myShort,
          theirShort,
          hasShort: myShort || theirShort,
        };
      });
  }, [myShift, sameDayShifts, shifts]);

  return (
    <div style={{ padding: "1rem", maxWidth: 900, margin: "0 auto" }}>
      <h1>Shift Trade Helper</h1>
      <p>
        Pick the shift you&apos;re working. The app will show other doctors on
        the same day and flag trades that create a{" "}
        <strong>SHORT TURNAROUND (&lt; 12 hours)</strong> for you or them.
      </p>

      {error && (
        <p style={{ color: "red", marginTop: "1rem" }}>
          {error} (The calendar URL or access might be wrong.)
        </p>
      )}

      <hr style={{ margin: "1rem 0" }} />

      <section>
        <h2>1. Select your shift</h2>
        {shifts.length === 0 && !error && <p>Loading shifts…</p>}

        {shifts.length > 0 && (
          <select
            value={selectedIndex}
            onChange={(e) => setSelectedIndex(e.target.value)}
            style={{ minWidth: "100%", padding: "0.5rem", marginTop: "0.5rem" }}
          >
            <option value="">-- Choose one of your shifts --</option>
            {shifts.map((s, idx) => (
              <option key={idx} value={idx}>
                {s.date} — {s.shiftName} — {s.doctor}
              </option>
            ))}
          </select>
        )}
      </section>

      <hr style={{ margin: "1rem 0" }} />

      <section>
        <h2>2. Shifts on the same day</h2>
        {!myShift && <p>Select your shift above to see same-day shifts.</p>}

        {myShift && (
          <>
            <p>
              <strong>Your shift:</strong> {myShift.date} — {myShift.shiftName} —{" "}
              {myShift.doctor} ({myShift.startTime}–{myShift.endTime})
            </p>

            <table
              border={1}
              cellPadding={4}
              style={{ borderCollapse: "collapse", marginTop: "0.5rem" }}
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
                    <td>{s.shiftName || s.raw}</td>
                    <td>{s.doctor}</td>
                    <td>{s.startTime}</td>
                    <td>{s.endTime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <hr style={{ margin: "1rem 0" }} />

      <section>
        <h2>3. Trade analysis</h2>
        {!myShift && <p>Select your shift above to see trade options.</p>}

        {myShift && tradeOptions.length === 0 && (
          <p>No other shifts on that day to trade with.</p>
        )}

        {myShift && tradeOptions.length > 0 && (
          <table
            border={1}
            cellPadding={4}
            style={{ borderCollapse: "collapse", marginTop: "0.5rem" }}
          >
            <thead>
              <tr>
                <th>Candidate shift</th>
                <th>Doctor</th>
                <th>Start</th>
                <th>End</th>
                <th>Turnaround risk</th>
              </tr>
            </thead>
            <tbody>
              {tradeOptions.map((t, i) => (
                <tr key={i}>
                  <td>{t.candidate.shiftName || t.candidate.raw}</td>
                  <td>{t.candidate.doctor}</td>
                  <td>{t.candidate.startTime}</td>
                  <td>{t.candidate.endTime}</td>
                  <td>
                    {t.hasShort ? (
                      <>
                        <strong>SHORT TURNAROUND</strong>{" "}
                        {t.myShort && "(for YOU) "} 
                        {t.theirShort && "(for THEM)"}
                      </>
                    ) : (
                      "OK (≥ 12h for both)"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
