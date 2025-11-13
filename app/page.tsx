"use client";

import React, { useEffect, useMemo, useState } from "react";

type Shift = {
  date: string;       // "2025-11-17"
  shiftName: string; // "R-N", "Surge-AM", etc.
  startTime: string; // "23:00"
  endTime: string;   // "09:00"
  doctor: string;
  location?: string;
  raw?: string;
};

// 🔴 FILL THIS IN with real emails / phones when you have permission.
const CONTACTS: Record<string, { email?: string; phone?: string }> = {
  // "Klassen": { email: "you@example.com", phone: "+1-204-555-1234" },
  // "O'Leary": { email: "oleary@example.com" },
};

function toDateTime(date: string, time: string): Date {
  if (!date || !time) return new Date(NaN);
  return new Date(`${date}T${time}:00`);
}

function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = toDateTime(shift.date, shift.startTime);
  let end = toDateTime(shift.date, shift.endTime);

  // Overnight shifts: if end <= start, push end to next day
  if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return { start, end };
}

function hoursDiff(later: Date, earlier: Date) {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60);
}

/**
 * Find the end time of the most recent shift for `doctor` that ends
 * before `referenceStart`, ignoring any shifts in `ignore`.
 */
function findPreviousShiftEnd(
  allShifts: Shift[],
  doctor: string,
  referenceStart: Date,
  ignore: Shift[] = []
): Date | null {
  const ends: Date[] = [];

  for (const s of allShifts) {
    if (ignore.includes(s)) continue; // pretend this shift doesn't exist
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

export default function Page() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedShiftIndex, setSelectedShiftIndex] = useState("");

  // user contact info for messages
  const [userEmail, setUserEmail] = useState("");
  const [userPhone, setUserPhone] = useState("");

  // Load schedule from API
  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) {
          setError("Could not load schedule.");
          return;
        }
        const sorted = [...data].sort((a, b) =>
          `${a.date} ${a.startTime}`.localeCompare(
            `${b.date} ${b.startTime}`
          )
        );
        setShifts(sorted);
      })
      .catch(() => setError("Could not load schedule."));
  }, []);

  // All doctor names
  const doctors = useMemo(
    () =>
      Array.from(
        new Set(
          shifts
            .map((s) => (s.doctor || "").trim())
            .filter((name) => name.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [shifts]
  );

  // FUTURE shifts for selected doctor only
  const doctorShifts = useMemo(() => {
    if (!selectedDoctor) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0); // midnight today

    return shifts
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => {
        const docMatches =
          (s.doctor || "").trim().toLowerCase() ===
          selectedDoctor.trim().toLowerCase();
        if (!docMatches) return false;

        const shiftDate = new Date(s.date + "T00:00:00");
        return shiftDate >= today;
      });
  }, [selectedDoctor, shifts]);

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

        // Scenario A: YOU take THEIR shift – ignore your original shift.
        const myPrev = findPreviousShiftEnd(
          shifts,
          myDoctor,
          theirStart,
          [myShift]
        );
        if (myPrev) {
          const gap = hoursDiff(theirStart, myPrev);
          if (gap < 12) myShort = true;
        }

        // Scenario B: THEY take YOUR shift – ignore their original shift.
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

  // build the message body for email/SMS
const buildOfferMessage = (candidate: Shift) => {
  if (!myShift) return "";

  const meName = selectedDoctor || "Unknown doctor";
  const meLabel = meName ? `Dr. ${meName}` : "Unknown doctor";

  const myShiftStr = `${myShift.date} ${myShift.shiftName} ${myShift.startTime}–${myShift.endTime}`;
  const theirShiftStr = `${candidate.date} ${candidate.shiftName} ${candidate.startTime}–${candidate.endTime}`;

  const contactBits = [userEmail, userPhone].filter(Boolean).join(" / ");
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

  // Email offer
  const handleSendEmailOffer = (candidate: Shift) => {
    if (!myShift) return;

    const message = buildOfferMessage(candidate);
    if (!message) return;

    const meName = selectedDoctor || "Unknown doctor";
    const otherName = candidate.doctor;

    const otherEmail = CONTACTS[otherName]?.email ?? "";
    const myEmail = userEmail || CONTACTS[meName]?.email || "";

    if (otherEmail || myEmail) {
      const to = otherEmail || myEmail;
      const ccParam =
        otherEmail && myEmail && otherEmail !== myEmail
          ? `&cc=${encodeURIComponent(myEmail)}`
          : "";
      const subject = encodeURIComponent(
  `SAME DAY SHIFT TRADE OFFER from ${meName}`
);
      );
      const body = encodeURIComponent(message);
      const mailto = `mailto:${encodeURIComponent(
        to
      )}?subject=${subject}${ccParam}&body=${body}`;
      window.location.href = mailto;
    } else {
      // Fallback: copy to clipboard
      if (navigator.clipboard) {
        navigator.clipboard
          .writeText(message)
          .then(() => {
            alert(
              "Trade offer text copied to clipboard.\nPaste it into an email."
            );
          })
          .catch(() => {
            alert(message);
          });
      } else {
        alert(message);
      }
    }
  };

  // SMS offer
  const handleSendSmsOffer = (candidate: Shift) => {
    if (!myShift) return;

    const message = buildOfferMessage(candidate);
    if (!message) return;

    const meName = selectedDoctor || "Unknown doctor";
    const otherName = candidate.doctor;

    const otherPhone = CONTACTS[otherName]?.phone ?? "";
    const myPhone = userPhone || CONTACTS[meName]?.phone || "";

    if (otherPhone || myPhone) {
      const to = otherPhone || myPhone;
      // Most phones understand sms:+number?body=...
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
              "Trade offer text copied to clipboard.\nPaste it into your SMS/texting app."
            );
          })
          .catch(() => {
            alert(message);
          });
      } else {
        alert(message);
      }
    }
  };

  return (
    <div style={{ padding: "1rem", maxWidth: 900, margin: "0 auto" }}>
      <h1>Same-Day Trades</h1>
      <p style={{ fontStyle: "italic", color: "#555" }}>
        Mode: <strong>Same-Day Trades</strong> (future modes: Lunch, Snacks,
        Beer, Evening Out)
      </p>
      <p>
        1) Enter your contact info (optional). 2) Choose{" "}
        <strong>your name</strong>. 3) Choose one of{" "}
        <strong>your future shifts</strong>. The app shows who else works that
        day and flags trades that create a{" "}
        <strong>SHORT TURNAROUND (&lt; 12h)</strong> for either doctor.
      </p>
      <p style={{ fontStyle: "italic", marginLeft: "1rem" }}>
        Example shift labels:
        <br />
        2025-11-17 R-N 23:00–09:00
        <br />
        2025-11-18 Surge-AM 08:00–17:00
      </p>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <hr />

      {/* Contact info */}
      <h2>Your contact info (for trade offers)</h2>
      <div style={{ marginBottom: "0.5rem" }}>
        <label>
          Email:&nbsp;
          <input
            type="email"
            value={userEmail}
            onChange={(e) => setUserEmail(e.target.value)}
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
            value={userPhone}
            onChange={(e) => setUserPhone(e.target.value)}
            style={{ width: "100%", maxWidth: 400 }}
            placeholder="+1-204-555-1234"
          />
        </label>
      </div>
      <p style={{ fontSize: "0.9rem", color: "#555" }}>
        Your email/phone are only used to fill in the trade-offer message.
        Nothing is sent automatically; you always confirm via your email or SMS
        app.
      </p>

      <hr />

      {/* Doctor dropdown */}
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

      {/* Shift dropdown */}
      <h2>2. Pick one of your future shifts</h2>
      {!selectedDoctor && <p>Select your name first.</p>}

      {selectedDoctor && doctorShifts.length === 0 && (
        <p>No future shifts found for {selectedDoctor}.</p>
      )}

      {selectedDoctor && doctorShifts.length > 0 && (
        <select
          value={selectedShiftIndex}
          onChange={(e) => setSelectedShiftIndex(e.target.value)}
          style={{ width: "100%", padding: "0.5rem" }}
        >
          <option value="">-- Choose a shift --</option>
          {doctorShifts.map(({ s, index }) => {
            const date = s.date || "????-??-??";
            const name = s.shiftName || "Unknown";
            const start = s.startTime || "??:??";
            const end = s.endTime || "??:??";

            const label = `${date} ${name} ${start}–${end}`;

            return (
              <option key={index} value={index}>
                {label}
              </option>
            );
          })}
        </select>
      )}

      <hr />

      <h2>Shifts on that day</h2>
      {!myShift && <p>Choose one of your shifts above.</p>}
      {myShift && (
        <>
          <p>
            <strong>Your shift:</strong>{" "}
            {myShift.date} {myShift.shiftName} ({myShift.startTime}–
            {myShift.endTime})
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

      <h2>Trade analysis</h2>
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
            style={{ borderCollapse: "collapse", minWidth: 500 }}
          >
            <thead>
              <tr>
                <th>Candidate Shift</th>
                <th>Doctor</th>
                <th>Start</th>
                <th>End</th>
                <th>Turnaround Risk</th>
                <th>Send offer</th>
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
                        onClick={() => handleSendEmailOffer(t.candidate)}
                        style={{ padding: "0.25rem 0.5rem" }}
                      >
                        Email / copy
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSendSmsOffer(t.candidate)}
                        style={{ padding: "0.25rem 0.5rem" }}
                      >
                        SMS / copy
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
