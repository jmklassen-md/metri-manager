"use client";

import React, { useEffect, useMemo, useState } from "react";

type Shift = {
  date: string;       // YYYY-MM-DD
  shiftName: string;  // parsed shift name, e.g. "Surge AM" or "R-N"
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  doctor: string;
  location?: string;
  raw?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  ends.sort((a, b) => b.getTime() - a.getTime());
  return ends[0];
}

function formatPrettyDate(isoDate: string): string {
  // isoDate like "2025-11-17"
  const d = new Date(isoDate + "T00:00:00");
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-US", {
    month: "short", // "Nov"
    day: "numeric", // "17"
    year: "numeric", // "2025"
  });
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Page() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedShiftIndex, setSelectedShiftIndex] = useState("");

  // Fetch all shifts from API
  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) {
          setError("Could not load schedule.");
          return;
        }
        // Sort globally by date + time
        const sorted = [...data].sort((a, b) =>
          `${a.date} ${a.startTime}`.localeCompare(
            `${b.date} ${b.startTime}`
          )
        );
        setShifts(sorted);
      })
      .catch(() => setError("Could not load schedule."));
  }, []);

  // Unique doctor names for dropdown 1
  const doctors = useMemo(
    () =>
      Array.from(
        new Set(
          shifts
            .map((s) => s.doctor.trim())
            .filter((name) => name && name.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [shifts]
  );

  // ALL shifts (past + future) for this doctor only
  const doctorShifts = useMemo(
    () =>
      shifts
        .map((s, index) => ({ s, index }))
        .filter(
          ({ s }) =>
            selectedDoctor &&
            s.doctor.trim().toLowerCase() ===
              selectedDoctor.trim().toLowerCase()
        ),
    [selectedDoctor, shifts]
  );

  const myShift =
    selectedShiftIndex === ""
      ? null
      : shifts[parseInt(selectedShiftIndex, 10)];

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

        let myShort = false;
        let theirShort = false;

        // If YOU take THEIR shift: your previous end -> theirStart
        const myPrev = findPreviousShiftEnd(shifts, myDoctor, theirStart);
        if (myPrev) {
          const gap = hoursDiff(theirStart, myPrev);
          if (gap < 12) myShort = true;
        }

        // If THEY take YOUR shift: their previous end -> yourStart
        const theirPrev = findPreviousShiftEnd(
          shifts,
          candidate.doctor,
          myStart
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

  return (
    <div style={{ padding: "1rem", maxWidth: 900, margin: "0 auto" }}>
      <h1>Shift Trade Helper</h1>
      <p>
        1) Choose <strong>your name</strong>. 2) Choose one of{" "}
        <strong>your shifts</strong> listed as:
        <br />
        <em>Nov 17, 2025, Surge AM 08:00–17:00</em>
        <br />
        The app will show who else works that day and whether a trade
        creates a <strong>SHORT TURNAROUND (&lt; 12 hours)</strong> for
        either doctor.
      </p>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <hr />

      {/* Dropdown 1: doctor name */}
      <h2>1. Pick your name</h2>
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

      <hr />

      {/* Dropdown 2: that doctor's shifts only, formatted nicely */}
      <h2>2. Pick one of your shifts</h2>
      {!selectedDoctor && <p>Select your name first.</p>}

      {selectedDoctor && doctorShifts.length === 0 && (
        <p>No shifts found for {selectedDoctor}.</p>
      )}

      {selectedDoctor && doctorShifts.length > 0 && (
        <select
          value={selectedShiftIndex}
          onChange={(e) => setSelectedShiftIndex(e.target.value)}
          style={{ width: "100%", padding: "0.5rem" }}
        >
          <option value="">-- Choose a shift --</option>
          {doctorShifts.map(({ s, index }) => (
            <option key={index} value={index}>
              {formatPrettyDate(s.date)}, {s.shiftName}{" "}
              {s.startTime}-{s.endTime}
            </option>
          ))}
        </select>
      )}

      <hr />

      {/* Same-day shifts */}
      <h2>Shifts on that day</h2>
      {!myShift && <p>Choose one of your shifts above.</p>}
      {myShift && (
        <>
          <p>
            <strong>Your shift:</strong>{" "}
            {formatPrettyDate(myShift.date)}, {myShift.shiftName} (
            {myShift.startTime}–{myShift.endTime})
          </p>
          <table
            border={1}
            cellPadding={4}
            style={{ borderCollapse: "collapse" }}
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
        </>
      )}

      <hr />

      {/* Trade analysis */}
      <h2>Trade analysis</h2>
      {!myShift && (
        <p>Select a shift above to see potential trade risks.</p>
      )}

      {myShift && tradeOptions.length === 0 && (
        <p>No other shifts on that day.</p>
      )}

      {myShift && tradeOptions.length > 0 && (
        <table
          border={1}
          cellPadding={4}
          style={{ borderCollapse: "collapse" }}
        >
          <thead>
            <tr>
              <th>Candidate Shift</th>
              <th>Doctor</th>
              <th>Start</th>
              <th>End</th>
              <th>Turnaround Risk</th>
            </tr>
          </thead>
          <tbody>
            {tradeOptions.map((t, i) => (
              <tr key={i}>
                <td>{t.candidate.shiftName}</td>
                <td>{t.candidate.doctor}</td>
                <td>{t.candidate.startTime}</td>
                <td>{t.candidate.endTime}</td>
                <td style={{ color: t.hasShort ? "red" : "green" }}>
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
      )}
    </div>
  );
}
