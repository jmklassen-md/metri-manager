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

type GetTogetherWarning = {
  doctor: string;
  shiftName: string;
  shiftDate: string; // shift start date
};

type GetTogetherDate = {
  date: string; // considered get-together date
  preNights: GetTogetherWarning[];
  comingOffDays: GetTogetherWarning[];
  postNights: GetTogetherWarning[];
};

// ---------- Helper functions ----------

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

function makeDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00`);
}

// For overnight shifts adjust end datetime
function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = makeDateTime(shift.date, shift.startTime);
  let end = makeDateTime(shift.date, shift.endTime);
  if (end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  return { start, end };
}

function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

// Interval overlap check
function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}

function previousDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ICS builder for Get Together
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

// ---------- Component ----------

export default function HomePage() {
  const [mode, setMode] = useState<Mode>("sameDayTrades");

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Same-Day Trades
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedShiftId, setSelectedShiftId] = useState("");
  const [tradeCandidates, setTradeCandidates] = useState<TradeCandidate[]>([]);
  const [activeTradeOffer, setActiveTradeOffer] =
    useState<TradeCandidate | null>(null);

  // Get Together
  const [selectedDoctorsForMeet, setSelectedDoctorsForMeet] = useState<string[]>(
    []
  );

  // Contacts (optional, via DB)
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Load schedule
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setLoadError(null);
        const res = await fetch("/api/schedule");
        if (!res.ok) throw new Error(`Failed to load schedule: ${res.status}`);
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

  // Load contacts
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/contacts");
        if (!res.ok) return;
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

  const allDoctors = useMemo(
    () => Array.from(new Set(shifts.map((s) => s.doctor))).sort(),
    [shifts]
  );

  // ---------- SAME-DAY TRADES – FUTURE SHIFTS ONLY ----------

  const myFutureShifts = useMemo(() => {
    if (!selectedDoctor) return [];
    return shifts
      .filter(
        (s) =>
          s.doctor === selectedDoctor &&
          s.date >= todayStr // only future (or today) by date
      )
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
    return myFutureShifts.find((s) => s.id === selectedShiftId) || null;
  }, [myFutureShifts, selectedShiftId]);

  function checkShortTurnaroundsForDoctor(
    all: Shift[],
    doctor: string,
    oldShift: Shift,
    newShift: Shift
  ): TradeShortTurnaround[] {
    const relevant = all.filter((s) => s.doctor === doctor);

    // Remove the shift being traded away, add the shift being traded into
    const filtered = relevant.filter(
      (s) =>
        !(
          s.date === oldShift.date &&
          s.shiftName === oldShift.shiftName &&
          s.startTime === oldShift.startTime &&
          s.endTime === oldShift.endTime
        )
    );

    const updated = [
      ...filtered,
      {
        ...newShift,
        doctor,
      },
    ];

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

  // Build candidates any time my selected shift changes
  useEffect(() => {
    if (!selectedMyShift) {
      setTradeCandidates([]);
      setActiveTradeOffer(null);
      return;
    }
    const myShift = selectedMyShift as Shift & { id: string };

    const sameDayShifts = shifts.filter(
      (s) => s.date === myShift.date && s.doctor !== myShift.doctor
    );

    const candidates: TradeCandidate[] = sameDayShifts.map((otherShift) => {
      const meProblems = checkShortTurnaroundsForDoctor(
        shifts,
        myShift.doctor,
        myShift,
        otherShift
      );
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

  // ---------- GET TOGETHER – DATES & WARNINGS (REWORKED) ----------

  const getTogetherDates: GetTogetherDate[] = useMemo(() => {
    if (mode !== "getTogether") return [];
    const selected = selectedDoctorsForMeet;
    if (selected.length === 0) return [];

    // Candidate dates = all dates in schedule (we will filter to future)
    const allDates = Array.from(new Set(shifts.map((s) => s.date))).sort();

    const result: GetTogetherDate[] = [];

    for (const date of allDates) {
      if (date < todayStr) continue; // only future dates

      const prevDate = previousDateStr(date);

      const eveningStart = new Date(`${date}T17:00:00`);
      const eveningEnd = new Date(`${date}T22:00:00`);

      const dayStart = new Date(`${date}T10:00:00`);
      const dayEnd = new Date(`${date}T14:00:00`);

      const preStart = new Date(`${date}T22:00:00`);
      const preEnd = new Date(`${date}T23:59:59`);

      const prevPreStart = new Date(`${prevDate}T22:00:00`);
      const prevPreEnd = new Date(`${prevDate}T23:59:59`);

      let allFree = true;
      const preNightsForDate: GetTogetherWarning[] = [];
      const comingOffDaysForDate: GetTogetherWarning[] = [];
      const postNightsForDate: GetTogetherWarning[] = [];

      for (const doc of selected) {
        const docShifts = shifts.filter((s) => s.doctor === doc);

        let hasPre = false;
        let hasDay = false;
        let hasPost = false;

        for (const s of docShifts) {
          const { start, end } = getShiftDateTimes(s);

          // 1. Evening availability test – any overlap with 17:00–22:00 means NOT free
          if (intervalsOverlap(start, end, eveningStart, eveningEnd)) {
            allFree = false;
            break;
          }

          // 2. Coming off days (overlaps 10:00–14:00 on this date)
          if (!hasDay) {
            if (intervalsOverlap(start, end, dayStart, dayEnd)) {
              comingOffDaysForDate.push({
                doctor: doc,
                shiftName: s.shiftName,
                shiftDate: s.date,
              });
              hasDay = true;
            }
          }

          // 3. Pre-nights – shift starting on THIS date at or after 22:00
          if (!hasPre && s.date === date && start >= preStart && start <= preEnd) {
            preNightsForDate.push({
              doctor: doc,
              shiftName: s.shiftName,
              shiftDate: s.date,
            });
            hasPre = true;
          }

          // 4. Post-nights – shift starting on PREVIOUS date at or after 22:00
          if (
            !hasPost &&
            s.date === prevDate &&
            start >= prevPreStart &&
            start <= prevPreEnd
          ) {
            postNightsForDate.push({
              doctor: doc,
              shiftName: s.shiftName,
              shiftDate: s.date,
            });
            hasPost = true;
          }
        }

        if (!allFree) break;
      }

      if (allFree) {
        result.push({
          date,
          preNights: preNightsForDate,
          comingOffDays: comingOffDaysForDate,
          postNights: postNightsForDate,
        });
      }
    }

    return result;
  }, [mode, selectedDoctorsForMeet, shifts, todayStr]);

  // ---------- Same-Day Trade messaging ----------

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

  // ---------- Get Together email helpers ----------

  function handleEmailGetTogetherList() {
    if (getTogetherDates.length === 0 || selectedDoctorsForMeet.length === 0)
      return;

    const recipients = selectedDoctorsForMeet
      .map((doc) => contactMap.get(doc)?.email)
      .filter(Boolean) as string[];
    const to = recipients.join(",");

    const dateLines = getTogetherDates
      .map(({ date, preNights, comingOffDays, postNights }) => {
        const label = formatDateLabel(date);
        const bits: string[] = [];

        preNights.forEach((w) =>
          bits.push(
            `${w.doctor} is pre-nights (${w.shiftName} on ${formatDateLabel(
              w.shiftDate
            )})`
          )
        );
        comingOffDays.forEach((w) =>
          bits.push(
            `${w.doctor} is coming off days (${w.shiftName} on ${formatDateLabel(
              w.shiftDate
            )})`
          )
        );
        postNights.forEach((w) =>
          bits.push(
            `${w.doctor} is post-nights (${w.shiftName} on ${formatDateLabel(
              w.shiftDate
            )})`
          )
        );

        const warningsText =
          bits.length > 0 ? ` (Warnings: ${bits.join("; ")})` : "";
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
                Choose your name, then one of your <strong>future</strong>{" "}
                shifts. I’ll list all other shifts on that same day and flag any
                trades that would create a short turnaround (&lt; 12 hours
                between shifts for either doctor).
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
                                  borderBottom: "1px solid "#eee",
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

                  {/* Active trade offer */}
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
                                {st.doctor}: {formatShiftLabel(st.existingShift)}{" "}
                                → {formatShiftLabel(st.newShift)} (gap ≈{" "}
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
                are free after 17:00. If someone is pre-nights (22:00–24:00),
                coming off days (10:00–14:00), or post-nights (night starting
                ≥ 22:00 the previous day), I’ll flag it with a warning.
              </p>

              {/* Doctor multi-select */}
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
                          ({ date, preNights, comingOffDays, postNights }) => {
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

                              const warningLines: string[] = [];
                              preNights.forEach((w) =>
                                warningLines.push(
                                  `${w.doctor} is pre-nights (${w.shiftName} on ${formatDateLabel(
                                    w.shiftDate
                                  )})`
                                )
                              );
                              comingOffDays.forEach((w) =>
                                warningLines.push(
                                  `${w.doctor} is coming off days (${w.shiftName} on ${formatDateLabel(
                                    w.shiftDate
                                  )})`
                                )
                              );
                              postNights.forEach((w) =>
                                warningLines.push(
                                  `${w.doctor} is post-nights (${w.shiftName} on ${formatDateLabel(
                                    w.shiftDate
                                  )})`
                                )
                              );

                              const warningsText =
                                warningLines.length > 0
                                  ? `Warnings:\n${warningLines
                                      .map((l) => `- ${l}`)
                                      .join("\n")}\n\n`
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

                                {/* Warnings */}
                                <div
                                  style={{
                                    fontSize: "0.8rem",
                                    color: "#b45309",
                                    marginTop: "0.15rem",
                                  }}
                                >
                                  {postNights.map((w, idx) => (
                                    <div key={`post-${w.doctor}-${idx}`}>
                                      ⚠ Warning: {w.doctor} is post-nights (
                                      {w.shiftName} on{" "}
                                      {formatDateLabel(w.shiftDate)})
                                    </div>
                                  ))}
                                  {comingOffDays.map((w, idx) => (
                                    <div key={`day-${w.doctor}-${idx}`}>
                                      ⚠ Warning: {w.doctor} is coming off days (
                                      {w.shiftName} on{" "}
                                      {formatDateLabel(w.shiftDate)})
                                    </div>
                                  ))}
                                  {preNights.map((w, idx) => (
                                    <div key={`pre-${w.doctor}-${idx}`}>
                                      ⚠ Warning: {w.doctor} is pre-nights (
                                      {w.shiftName} on{" "}
                                      {formatDateLabel(w.shiftDate)})
                                    </div>
                                  ))}
                                </div>

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
