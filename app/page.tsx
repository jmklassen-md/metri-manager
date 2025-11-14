"use client";

import React, { useEffect, useMemo, useState } from "react";

type Shift = {
  date: string; // "YYYY-MM-DD"
  shiftName: string;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  doctor: string;
  location: string;
  raw: string;
};

type Contact = {
  doctor_name: string;
  email: string | null;
  phone: string | null;
  preferred: string | null;
};

type Mode = "sameDayTrades" | "getTogether";

type TradeShortTurnaround = {
  doctor: string;
  existingShift: Shift;
  newShift: Shift;
  gapHours: number;
};

type TradeCandidate = {
  otherShift: Shift;
  shortTurnarounds: TradeShortTurnaround[];
};

type GetTogetherDate = {
  date: string;
  nights: { doctor: string; shiftName: string; startTime: string; endTime: string }[];
  dayShifts: { doctor: string; shiftName: string; startTime: string; endTime: string }[];
  postNights: { doctor: string; shiftName: string; startTime: string; endTime: string }[];
};

// ---------- Helper functions (shared) ----------

function formatDateLabel(date: string): string {
  return new Date(date).toLocaleDateString("en-CA", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatShiftLabel(shift: Shift): string {
  return `${formatDateLabel(shift.date)}, ${shift.shiftName} ${shift.startTime}–${shift.endTime}`;
}

// Convert date+time into a Date object in local time
function makeDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00`);
}

// Adjust end datetime for overnight shifts
function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = makeDateTime(shift.date, shift.startTime);
  let end = makeDateTime(shift.date, shift.endTime);

  // If end is "before" start, treat as overnight (end next day)
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return { start, end };
}

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

function intervalOverlaps(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

// Check if swapping into newShift would create < 12h between any two of doctor’s shifts
function checkShortTurnaroundsForDoctor(
  allShifts: Shift[],
  doctor: string,
  oldShift: Shift,
  newShift: Shift
): TradeShortTurnaround[] {
  const relevant = allShifts.filter((s) => s.doctor === doctor);

  // Remove oldShift (the one they’re giving up) from their list
  const filtered = relevant.filter(
    (s) =>
      !(
        s.date === oldShift.date &&
        s.shiftName === oldShift.shiftName &&
        s.startTime === oldShift.startTime &&
        s.endTime === oldShift.endTime
      )
  );

  // Add the newShift (the one they would be working instead)
  const updated = [
    ...filtered,
    {
      ...newShift,
      doctor,
    },
  ];

  // Sort by start time
  const withTimes = updated.map((s) => ({
    shift: s,
    ...getShiftDateTimes(s),
  }));
  withTimes.sort((a, b) => a.start.getTime() - b.start.getTime());

  const problems: TradeShortTurnaround[] = [];

  for (let i = 0; i < withTimes.length - 1; i++) {
    const current = withTimes[i];
    const next = withTimes[i + 1];

    const gapHours =
      (next.start.getTime() - current.end.getTime()) / (1000 * 60 * 60);
    if (gapHours < 12) {
      problems.push({
        doctor,
        existingShift: current.shift,
        newShift: next.shift,
        gapHours,
      });
    }
  }

  return problems;
}

// ---------- Get Together helpers ----------

// Night shift = starts at or after 22:00 (for that date’s evening)
function isNightShift(shift: Shift): boolean {
  const [shStartH, shStartM] = shift.startTime.split(":").map(Number);
  const startMinutes = shStartH * 60 + shStartM;
  const nightCutoff = 22 * 60; // 22:00
  return startMinutes >= nightCutoff;
}

// Minimal all-day ICS builder for a single date
function buildGetTogetherICS(date: string, doctors: string[]): string {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Metri-Manager//GetTogether//EN",
    "BEGIN:VEVENT",
    `UID:get-together-${date}@metri-manager`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
    `DTSTART;VALUE=DATE:${y}${m}${d}`,
    `SUMMARY:Get together (${doctors.join(", ")})`,
    `DESCRIPTION:Get together for ${doctors.join(", ")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

// ---------- Main Page Component ----------

export default function HomePage() {
  const [mode, setMode] = useState<Mode>("sameDayTrades");

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Same-Day Trades state
  const [selectedDoctor, setSelectedDoctor] = useState<string>("");
  const [selectedShiftId, setSelectedShiftId] = useState<string>("");
  const [tradeCandidates, setTradeCandidates] = useState<TradeCandidate[]>([]);
  const [activeTradeOffer, setActiveTradeOffer] = useState<TradeCandidate | null>(
    null
  );

  // Get Together state
  const [selectedDoctorsForMeet, setSelectedDoctorsForMeet] = useState<string[]>(
    []
  );

  // Contacts (optional)
  const [contacts, setContacts] = useState<Contact[]>([]);

  // ---------- Load shifts from /api/schedule ----------

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const res = await fetch("/api/schedule");
        if (!res.ok) {
          throw new Error(`Failed to load schedule: ${res.status}`);
        }
        const data = await res.json();
        setShifts(data as Shift[]);
      } catch (err: any) {
        console.error(err);
        setLoadError(err?.message || "Failed to load schedule");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ---------- Load contacts from /api/contacts (if available) ----------

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/contacts");
        if (!res.ok) return; // if not set up, silently skip
        const data = await res.json();
        setContacts(data as Contact[]);
      } catch (e) {
        console.error("Failed to load contacts", e);
      }
    })();
  }, []);

  const contactMap = useMemo(
    () => new Map(contacts.map((c) => [c.doctor_name, c])),
    [contacts]
  );

  const todayStr = new Date().toISOString().slice(0, 10);

  // ---------- Derived data ----------

  const allDoctors = useMemo(
    () => Array.from(new Set(shifts.map((s) => s.doctor))).sort(),
    [shifts]
  );

  // For Same-Day mode: doctor’s future shifts, each with a composite ID
  const myFutureShifts = useMemo(() => {
    if (!selectedDoctor) return [];
    return shifts
      .filter((s) => s.doctor === selectedDoctor && s.date >= todayStr)
      .sort((a, b) => {
        if (a.date === b.date) return a.startTime.localeCompare(b.startTime);
        return a.date.localeCompare(b.date);
      })
      .map((s) => ({
        ...s,
        id: `${s.date}__${s.shiftName}__${s.startTime}__${s.endTime}__${s.doctor}`,
      }));
  }, [shifts, selectedDoctor, todayStr]);

  const selectedMyShift = useMemo(() => {
    if (!selectedShiftId) return null;
    const found = myFutureShifts.find((s) => s.id === selectedShiftId);
    return found || null;
  }, [myFutureShifts, selectedShiftId]);

  // ---------- Compute same-day trade candidates when my shift changes ----------

  useEffect(() => {
    if (!selectedMyShift) {
      setTradeCandidates([]);
      setActiveTradeOffer(null);
      return;
    }
    const myShift = selectedMyShift as Shift & { id: string };

    // Other shifts on the same date (different doctors)
    const sameDayShifts = shifts.filter(
      (s) => s.date === myShift.date && s.doctor !== myShift.doctor
    );

    const candidates: TradeCandidate[] = sameDayShifts.map((otherShift) => {
      // Check me: I give up myShift, I take otherShift
      const meProblems = checkShortTurnaroundsForDoctor(
        shifts,
        myShift.doctor,
        myShift,
        otherShift
      );

      // Check them: they give up otherShift, they take myShift
      const themProblems = checkShortTurnaroundsForDoctor(
        shifts,
        otherShift.doctor,
        otherShift,
        myShift
      );

      return {
        otherShift,
        shortTurnarounds: [...meProblems, ...themProblems],
      };
    });

    setTradeCandidates(candidates);
    setActiveTradeOffer(null);
  }, [selectedMyShift, shifts]);

  // ---------- Get Together dates computation (with warnings) ----------

  const getTogetherDates: GetTogetherDate[] = useMemo(() => {
    if (mode !== "getTogether") return [];
    const selected = selectedDoctorsForMeet;
    if (selected.length === 0) return [];

    // Group shifts by date
    const byDate: Record<string, Shift[]> = {};
    for (const s of shifts) {
      if (!byDate[s.date]) byDate[s.date] = [];
      byDate[s.date].push(s);
    }

    const allDates = Object.keys(byDate).sort();
    const result: GetTogetherDate[] = [];

    for (const date of allDates) {
      if (date < todayStr) continue; // future only

      const dayShifts = byDate[date];

      let allFree = true;
      const nightsForThisDate: GetTogetherDate["nights"] = [];
      const dayShiftsForThisDate: GetTogetherDate["dayShifts"] = [];
      const postNightsForThisDate: GetTogetherDate["postNights"] = [];

      // Time windows for warnings
      const dayWindowStart = 10 * 60; // 10:00
      const dayWindowEnd = 14 * 60; // 14:00

      const dayStartMidnight = new Date(`${date}T00:00:00`);
      const dayEndSix = new Date(`${date}T06:00:00`);

      for (const doc of selected) {
        const docShiftsToday = dayShifts.filter((s) => s.doctor === doc);

        // Check today's shifts for evening blocks, nights, and "coming off a day shift"
        for (const s of docShiftsToday) {
          const [shStartH, shStartM] = s.startTime.split(":").map(Number);
          const [shEndH, shEndM] = s.endTime.split(":").map(Number);
          const startMinutes = shStartH * 60 + shStartM;
          const endMinutes = shEndH * 60 + shEndM;
          const overnight = endMinutes < startMinutes;
          const eveStart = 17 * 60;
          const eveEnd = 22 * 60;

          if (!overnight) {
            // Evening block check: overlap with 17:00–22:00
            if (startMinutes < eveEnd && endMinutes > eveStart) {
              allFree = false;
              break;
            }

            // Day-shift warning: overlap with 10:00–14:00
            if (
              startMinutes < dayWindowEnd &&
              endMinutes > dayWindowStart &&
              !dayShiftsForThisDate.some((d) => d.doctor === doc)
            ) {
              dayShiftsForThisDate.push({
                doctor: doc,
                shiftName: s.shiftName,
                startTime: s.startTime,
                endTime: s.endTime,
              });
            }
          } else {
            // Overnight shift starting today:
            // if it starts before 22:00, it blocks the evening
            if (startMinutes < eveEnd) {
              allFree = false;
              break;
            }
          }

          // Night shift warning for this date (working nights tonight)
          if (
            isNightShift(s) &&
            !nightsForThisDate.some((n) => n.doctor === doc)
          ) {
            nightsForThisDate.push({
              doctor: doc,
              shiftName: s.shiftName,
              startTime: s.startTime,
              endTime: s.endTime,
            });
          }
        }

        if (!allFree) break;

        // Post-nights warning: any shift for this doctor overlapping this date's 00:00–06:00
        const allDocShifts = shifts.filter((s) => s.doctor === doc);
        for (const s of allDocShifts) {
          const { start, end } = getShiftDateTimes(s);
          if (
            intervalOverlaps(start, end, dayStartMidnight, dayEndSix) &&
            !postNightsForThisDate.some((p) => p.doctor === doc)
          ) {
            postNightsForThisDate.push({
              doctor: doc,
              shiftName: s.shiftName,
              startTime: s.startTime,
              endTime: s.endTime,
            });
            break;
          }
        }
      }

      if (allFree) {
        result.push({
          date,
          nights: nightsForThisDate,
          dayShifts: dayShiftsForThisDate,
          postNights: postNightsForThisDate,
        });
      }
    }

    return result;
  }, [mode, selectedDoctorsForMeet, shifts, todayStr]);

  // ---------- Actions: Same-Day trade message ----------

  function buildSameDayTradeMessage(
    me: string,
    myShift: Shift,
    theirShift: Shift
  ): string {
    const meLabel = `Dr. ${me}`;
    return (
      `You've got a SAME-DAY SHIFT TRADE OFFER from ${meLabel}!\n\n` +
      `${meLabel} would like to trade:\n\n` +
      `  THEIR shift: ${formatShiftLabel(myShift)}\n` +
      `  FOR your shift: ${formatShiftLabel(theirShift)}\n\n` +
      `Please contact ${meLabel} if you're interested.\n\n` +
      `(Generated by the Metri-Manager – mode: Same-Day Trades.)`
    );
  }

  function handlePrepareTradeOffer(candidate: TradeCandidate) {
    setActiveTradeOffer(candidate);
  }

  // ---------- Actions: Get Together emails ----------

  function handleEmailGetTogetherList() {
    if (getTogetherDates.length === 0 || selectedDoctorsForMeet.length === 0)
      return;

    const recipients = selectedDoctorsForMeet
      .map((doc) => contactMap.get(doc)?.email)
      .filter(Boolean) as string[];

    const to = recipients.join(",");

    const dateLines = getTogetherDates
      .map(({ date, nights, dayShifts, postNights }) => {
        const label = formatDateLabel(date);
        const bits: string[] = [];

        if (nights.length > 0) {
          bits.push(
            `Night shifts: ${nights
              .map(
                (n) =>
                  `${n.doctor} ${n.shiftName} ${n.startTime}–${n.endTime}`
              )
              .join(", ")}`
          );
        }
        if (dayShifts.length > 0) {
          bits.push(
            `Coming off day shift: ${dayShifts
              .map(
                (d) =>
                  `${d.doctor} ${d.shiftName} ${d.startTime}–${d.endTime}`
              )
              .join(", ")}`
          );
        }
        if (postNights.length > 0) {
          bits.push(
            `Post nights: ${postNights
              .map(
                (p) =>
                  `${p.doctor} ${p.shiftName} ${p.startTime}–${p.endTime}`
              )
              .join(", ")}`
          );
        }

        const warningsText =
          bits.length > 0 ? ` (${bits.join(" | ")})` : "";

        return `- ${label}${warningsText}`;
      })
      .join("\n");

    const subject = encodeURIComponent(
      `Get Together – Free evenings for ${selectedDoctorsForMeet.join(", ")}`
    );

    const body = encodeURIComponent(
      `Hi everyone,\n\nHere are potential evenings when everyone is free after 17:00:\n\n${dateLines}\n\nGenerated by Metri-Manager – mode: Get Together.`
    );

    const mailto = `mailto:${encodeURIComponent(
      to
    )}?subject=${subject}&body=${body}`;
    window.location.href = mailto;
  }

  // ---------- Render ----------

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "1rem" }}>
      <h1>Metri-Manager</h1>
      <p style={{ marginBottom: "1rem" }}>
        SBH Shift Helper – Same-Day Trades &amp; Get Together planning.
      </p>

      {/* Mode toggle */}
      <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          onClick={() => setMode("sameDayTrades")}
          style={{
            padding: "0.4rem 0.8rem",
            borderRadius: 999,
            border: "1px solid #ccc",
            background: mode === "sameDayTrades" ? "#1d4ed8" : "#eee",
            color: mode === "sameDayTrades" ? "#fff" : "#000",
            cursor: "pointer",
          }}
        >
          Same-Day Trades
        </button>
        <button
          type="button"
          onClick={() => setMode("getTogether")}
          style={{
            padding: "0.4rem 0.8rem",
            borderRadius: 999,
            border: "1px solid #ccc",
            background: mode === "getTogether" ? "#1d4ed8" : "#eee",
            color: mode === "getTogether" ? "#fff" : "#000",
            cursor: "pointer",
          }}
        >
          Get Together
        </button>
      </div>

      {loading && <p>Loading schedule…</p>}
      {loadError && <p style={{ color: "red" }}>{loadError}</p>}

      {!loading && !loadError && (
        <>
          {/* SAME-DAY TRADES MODE */}
          {mode === "sameDayTrades" && (
            <section
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: "1rem",
                marginBottom: "1.5rem",
              }}
            >
              <h2>Same-Day Trades</h2>
              <p>
                Choose your name, then one of your future shifts. I’ll list all
                other shifts on that same day and flag any trades that would
                create a short turnaround (&lt; 12 hours between shifts for
                either doctor).
              </p>

              {/* Doctor selection */}
              <div style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
                <label>
                  Your name:{" "}
                  <select
                    value={selectedDoctor}
                    onChange={(e) => {
                      setSelectedDoctor(e.target.value);
                      setSelectedShiftId("");
                      setTradeCandidates([]);
                      setActiveTradeOffer(null);
                    }}
                  >
                    <option value="">Select your name</option>
                    {allDoctors.map((doc) => (
                      <option key={doc} value={doc}>
                        {doc}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Shift selection */}
              {selectedDoctor && (
                <div style={{ marginBottom: "1rem" }}>
                  <label>
                    Your future shifts:{" "}
                    <select
                      value={selectedShiftId}
                      onChange={(e) => {
                        setSelectedShiftId(e.target.value);
                        setActiveTradeOffer(null);
                      }}
                    >
                      <option value="">Select a shift</option>
                      {myFutureShifts.map((s) => (
                        <option key={s.id} value={s.id}>
                          {formatDateLabel(s.date)}, {s.shiftName}{" "}
                          {s.startTime}–{s.endTime}
                        </option>
                      ))}
                    </select>
                  </label>
                  {myFutureShifts.length === 0 && (
                    <p style={{ fontSize: "0.9rem" }}>
                      No future shifts found for {selectedDoctor}.
                    </p>
                  )}
                </div>
              )}

              {/* Trade candidates */}
              {selectedMyShift && (
                <div>
                  <h3>
                    Potential same-day trades on{" "}
                    {formatDateLabel(selectedMyShift.date)}
                  </h3>
                  {tradeCandidates.length === 0 && (
                    <p>No other shifts found on this day.</p>
                  )}
                  {tradeCandidates.length > 0 && (
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        marginBottom: "1rem",
                      }}
                    >
                      <thead>
                        <tr>
                          <th
                            style={{
                              borderBottom: "1px solid #ccc",
                              textAlign: "left",
                              padding: "0.25rem",
                            }}
                          >
                            Doctor
                          </th>
                          <th
                            style={{
                              borderBottom: "1px solid #ccc",
                              textAlign: "left",
                              padding: "0.25rem",
                            }}
                          >
                            Shift
                          </th>
                          <th
                            style={{
                              borderBottom: "1px solid #ccc",
                              textAlign: "left",
                              padding: "0.25rem",
                            }}
                          >
                            Status
                          </th>
                          <th
                            style={{
                              borderBottom: "1px solid #ccc",
                              textAlign: "left",
                              padding: "0.25rem",
                            }}
                          >
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {tradeCandidates.map((cand) => {
                          const hasShort = cand.shortTurnarounds.length > 0;
                          return (
                            <tr
                              key={`${cand.otherShift.doctor}-${cand.otherShift.shiftName}-${cand.otherShift.startTime}`}
                            >
                              <td
                                style={{
                                  borderBottom: "1px solid #eee",
                                  padding: "0.25rem",
                                }}
                              >
                                {cand.otherShift.doctor}
                              </td>
                              <td
                                style={{
                                  borderBottom: "1px solid #eee",
                                  padding: "0.25rem",
                                }}
                              >
                                {cand.otherShift.shiftName}{" "}
                                {cand.otherShift.startTime}–
                                {cand.otherShift.endTime}
                              </td>
                              <td
                                style={{
                                  borderBottom: "1px solid #eee",
                                  padding: "0.25rem",
                                  color: hasShort ? "#b91c1c" : "#166534",
                                  fontSize: "0.9rem",
                                }}
                              >
                                {hasShort ? "SHORT TURNAROUND" : "OK"}
                              </td>
                              <td
                                style={{
                                  borderBottom: "1px solid #eee",
                                  padding: "0.25rem",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={() => handlePrepareTradeOffer(cand)}
                                  style={{
                                    padding: "0.2rem 0.5rem",
                                    fontSize: "0.8rem",
                                    cursor: "pointer",
                                  }}
                                >
                                  Prepare offer
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}

                  {/* Detail of short turnarounds for selected candidate */}
                  {activeTradeOffer && (
                    <div
                      style={{
                        borderTop: "1px solid #ddd",
                        paddingTop: "0.75rem",
                        marginTop: "0.75rem",
                      }}
                    >
                      <h3>Trade Offer Message</h3>
                      {activeTradeOffer.shortTurnarounds.length > 0 && (
                        <div style={{ marginBottom: "0.5rem", color: "#b91c1c" }}>
                          <strong>Warning:</strong> This trade creates short
                          turnarounds:
                          <ul>
                            {activeTradeOffer.shortTurnarounds.map((st, i) => (
                              <li key={i}>
                                {st.doctor}: {formatShiftLabel(st.existingShift)} →{" "}
                                {formatShiftLabel(st.newShift)} (gap ≈{" "}
                                {st.gapHours.toFixed(1)} h)
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <p style={{ fontSize: "0.9rem" }}>
                        Below is an auto-generated message you can copy/paste
                        into email or text:
                      </p>
                      <textarea
                        readOnly
                        value={
                          selectedMyShift
                            ? buildSameDayTradeMessage(
                                selectedMyShift.doctor,
                                selectedMyShift,
                                activeTradeOffer.otherShift
                              )
                            : ""
                        }
                        style={{
                          width: "100%",
                          height: "8rem",
                          fontFamily: "monospace",
                          fontSize: "0.85rem",
                        }}
                      />

                      {/* Email link if we have their email */}
                      {(() => {
                        if (!selectedMyShift) return null;
                        const meName = selectedMyShift.doctor;
                        const themName = activeTradeOffer.otherShift.doctor;
                        const contact = contactMap.get(themName);
                        const msg = buildSameDayTradeMessage(
                          meName,
                          selectedMyShift,
                          activeTradeOffer.otherShift
                        );
                        const subject = encodeURIComponent(
                          `Same-day shift trade offer from Dr. ${meName}`
                        );
                        const body = encodeURIComponent(msg);

                        if (contact?.email) {
                          const mailto = `mailto:${encodeURIComponent(
                            contact.email
                          )}?subject=${subject}&body=${body}`;
                          return (
                            <div style={{ marginTop: "0.5rem" }}>
                              <a href={mailto}>Email this offer to {themName}</a>
                            </div>
                          );
                        }
                        return (
                          <p
                            style={{
                              marginTop: "0.5rem",
                              fontSize: "0.85rem",
                            }}
                          >
                            No email on file for {themName}. Copy the text above
                            into your preferred app.
                          </p>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* GET TOGETHER MODE */}
          {mode === "getTogether" && (
            <section
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: "1rem",
                marginBottom: "1.5rem",
              }}
            >
              <h2>Get Together – Free Evenings After 17:00</h2>
              <p>
                Select doctors below. I’ll show future dates where all of them
                are free after 17:00. If someone is on a night shift (start ≥
                22:00), is coming off a day shift (worked 10:00–14:00), or is
                post nights (worked 00:00–06:00), I’ll flag it with a warning.
              </p>

              {/* Multi-select doctors */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                  marginTop: "0.75rem",
                  marginBottom: "0.75rem",
                }}
              >
                {allDoctors.map((doc) => {
                  const checked = selectedDoctorsForMeet.includes(doc);
                  return (
                    <label
                      key={doc}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.25rem",
                        padding: "0.25rem 0.5rem",
                        borderRadius: 999,
                        border: "1px solid #ddd",
                        background: checked ? "#1d4ed8" : "#f9fafb",
                        color: checked ? "#fff" : "#000",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedDoctorsForMeet((prev) =>
                              [...prev, doc].sort()
                            );
                          } else {
                            setSelectedDoctorsForMeet((prev) =>
                              prev.filter((d) => d !== doc)
                            );
                          }
                        }}
                        style={{ accentColor: "#1d4ed8" }}
                      />
                      <span>{doc}</span>
                    </label>
                  );
                })}
              </div>

              {/* Results */}
              <div>
                {selectedDoctorsForMeet.length === 0 && (
                  <p>Select one or more doctors above to see free evenings.</p>
                )}

                {selectedDoctorsForMeet.length > 0 &&
                  getTogetherDates.length === 0 && (
                    <p>
                      No future dates found where all selected doctors are free
                      after 17:00.
                    </p>
                  )}

                {selectedDoctorsForMeet.length > 0 &&
                  getTogetherDates.length > 0 && (
                    <>
                      <div style={{ marginBottom: "0.5rem" }}>
                        <button
                          type="button"
                          onClick={handleEmailGetTogetherList}
                          style={{
                            padding: "0.3rem 0.7rem",
                            fontSize: "0.85rem",
                            cursor: "pointer",
                          }}
                        >
                          Email these dates to the group
                        </button>
                      </div>

                      <h3>Potential Get-Together Evenings</h3>
                      <ul style={{ listStyle: "none", paddingLeft: 0 }}>
                        {getTogetherDates.map(
                          ({ date, nights, dayShifts, postNights }) => {
                            const label = formatDateLabel(date);
                            const ics = buildGetTogetherICS(
                              date,
                              selectedDoctorsForMeet
                            );
                            const icsHref = `data:text/calendar;charset=utf-8,${encodeURIComponent(
                              ics
                            )}`;

                            const handleEmailSingleDate = () => {
                              const recipients = selectedDoctorsForMeet
                                .map((doc) => contactMap.get(doc)?.email)
                                .filter(Boolean) as string[];

                              const to = recipients.join(",");

                              const bits: string[] = [];
                              if (nights.length > 0) {
                                bits.push(
                                  `Night shifts: ${nights
                                    .map(
                                      (n) =>
                                        `${n.doctor} ${n.shiftName} ${n.startTime}–${n.endTime}`
                                    )
                                    .join(", ")}`
                                );
                              }
                              if (dayShifts.length > 0) {
                                bits.push(
                                  `Coming off day shift: ${dayShifts
                                    .map(
                                      (d) =>
                                        `${d.doctor} ${d.shiftName} ${d.startTime}–${d.endTime}`
                                    )
                                    .join(", ")}`
                                );
                              }
                              if (postNights.length > 0) {
                                bits.push(
                                  `Post nights: ${postNights
                                    .map(
                                      (p) =>
                                        `${p.doctor} ${p.shiftName} ${p.startTime}–${p.endTime}`
                                    )
                                    .join(", ")}`
                                );
                              }
                              const warningsText =
                                bits.length > 0
                                  ? bits.join(" ") + "\n\n"
                                  : "";

                              const subject = encodeURIComponent(
                                `Get Together – ${label}`
                              );

                              const body = encodeURIComponent(
                                `Hi everyone,\n\nHow about a get-together on ${label}?\n\n${warningsText}(You can add the attached .ics event to your calendar.)\n\nGenerated by Metri-Manager – mode: Get Together.`
                              );

                              const mailto = `mailto:${encodeURIComponent(
                                to
                              )}?subject=${subject}&body=${body}`;
                              window.location.href = mailto;
                            };

                            return (
                              <li
                                key={date}
                                style={{
                                  borderBottom: "1px solid #eee",
                                  padding: "0.5rem 0",
                                }}
                              >
                                <div>{label}</div>

                                {/* Night shifts warning */}
                                {nights.length > 0 && (
                                  <div
                                    style={{
                                      fontSize: "0.8rem",
                                      color: "#b45309",
                                      marginTop: "0.15rem",
                                    }}
                                  >
                                    ⚠ Working nights on this date:&nbsp;
                                    {nights
                                      .map(
                                        (n) =>
                                          `${n.doctor} (${n.shiftName} ${n.startTime}–${n.endTime})`
                                      )
                                      .join("; ")}
                                  </div>
                                )}

                                {/* Coming off day shift */}
                                {dayShifts.length > 0 && (
                                  <div
                                    style={{
                                      fontSize: "0.8rem",
                                      color: "#b45309",
                                      marginTop: "0.15rem",
                                    }}
                                  >
                                    ⚠ Coming off a day shift (worked between
                                    10:00 and 14:00):&nbsp;
                                    {dayShifts
                                      .map(
                                        (d) =>
                                          `${d.doctor} (${d.shiftName} ${d.startTime}–${d.endTime})`
                                      )
                                      .join("; ")}
                                  </div>
                                )}

                                {/* Post nights */}
                                {postNights.length > 0 && (
                                  <div
                                    style={{
                                      fontSize: "0.8rem",
                                      color: "#b45309",
                                      marginTop: "0.15rem",
                                    }}
                                  >
                                    ⚠ Post nights (worked between 00:00 and
                                    06:00):&nbsp;
                                    {postNights
                                      .map(
                                        (p) =>
                                          `${p.doctor} (${p.shiftName} ${p.startTime}–${p.endTime})`
                                      )
                                      .join("; ")}
                                  </div>
                                )}

                                <div
                                  style={{
                                    display: "flex",
                                    gap: "0.5rem",
                                    marginTop: "0.35rem",
                                    fontSize: "0.85rem",
                                  }}
                                >
                                  <a
                                    href={icsHref}
                                    download={`get-together-${date}.ics`}
                                  >
                                    Download .ics
                                  </a>
                                  <button
                                    type="button"
                                    onClick={handleEmailSingleDate}
                                    style={{
                                      padding: "0.2rem 0.5rem",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Email this date to group
                                  </button>
                                </div>
                              </li>
                            );
                          }
                        )}
                      </ul>
                    </>
                  )}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
