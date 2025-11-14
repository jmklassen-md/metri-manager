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

type Contact = {
  email: string;
  phone: string;
  preferred: "email" | "sms" | "either" | "none";
};

const CONTACTS_STORAGE_KEY = "metriManagerContacts";

// Optional: seed contacts if you want built-in defaults
const SEED_CONTACTS: Record<string, Contact> = {
  // "Klassen": { email: "you@example.com", phone: "+1-204-555-1234", preferred: "either" },
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

export default function Page() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedShiftIndex, setSelectedShiftIndex] = useState("");

  // "Database" of contacts (per doctor), stored in localStorage
  const [contacts, setContacts] = useState<Record<string, Contact>>({});

  // Draft contact info for the currently selected doctor
  const [contactDraft, setContactDraft] = useState<Contact>({
    email: "",
    phone: "",
    preferred: "none",
  });

  const [contactSavedMessage, setContactSavedMessage] = useState("");

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
          `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`)
        );
        setShifts(sorted);
      })
      .catch(() => setError("Could not load schedule."));
  }, []);

  // Load contacts from localStorage on first client render
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CONTACTS_STORAGE_KEY);
      const stored = raw ? (JSON.parse(raw) as Record<string, Contact>) : {};
      setContacts({ ...SEED_CONTACTS, ...stored });
    } catch {
      setContacts({ ...SEED_CONTACTS });
    }
  }, []);

  // Persist contacts whenever they change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const toStore = JSON.stringify(contacts);
      window.localStorage.setItem(CONTACTS_STORAGE_KEY, toStore);
    } catch {
      // ignore
    }
  }, [contacts]);

  // All doctor names (from schedule)
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
    selectedShiftIndex === "" ? null : shifts[parseInt(selectedShiftIndex, 10)];

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
        const myPrev = findPreviousShiftEnd(shifts, myDoctor, theirStart, [
          myShift,
        ]);
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

  const myContact: Contact | undefined =
    selectedDoctor && contacts[selectedDoctor]
      ? contacts[selectedDoctor]
      : undefined;

  const myEmail = myContact?.email || "";
  const myPhone = myContact?.phone || "";

  // Build the message body for email/SMS
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

  // Email offer
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

    // Communicate preference before sending
    if (otherContact) {
      if (otherContact.preferred === "sms") {
        const proceed = window.confirm(
          `Note: Dr. ${otherName} prefers SMS. Do you still want to start an email?`
        );
        if (!proceed) return;
      } else if (otherContact.preferred === "none") {
        const proceed = window.confirm(
          `Note: Dr. ${otherName} prefers not to share contact info.\nYou may want to coordinate in person or via internal messaging.\n\nDo you still want to proceed with an email (if possible)?`
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

    const otherContact = contacts[otherName];
    const otherPhone = otherContact?.phone ?? "";
    const myPhoneForSend = myPhone;

    // Communicate preference before sending
    if (otherContact) {
      if (otherContact.preferred === "email") {
        const proceed = window.confirm(
          `Note: Dr. ${otherName} prefers email. Do you still want to start an SMS?`
        );
        if (!proceed) return;
      } else if (otherContact.preferred === "none") {
        const proceed = window.confirm(
          `Note: Dr. ${otherName} prefers not to share contact info.\nYou may want to coordinate in person or via internal messaging.\n\nDo you still want to proceed with SMS (if possible)?`
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

  // Save contact info for selected doctor
  const handleSaveContact = () => {
    if (!selectedDoctor) return;
    setContacts((prev) => ({
      ...prev,
      [selectedDoctor]: {
        email: contactDraft.email.trim(),
        phone: contactDraft.phone.trim(),
        preferred: contactDraft.preferred,
      },
    }));
    setContactSavedMessage("Contact information saved.");
    setTimeout(() => setContactSavedMessage(""), 3000);
  };

  const myPreferenceText = myContact
    ? formatPreference(myContact)
    : "No contact info saved for you yet.";

  return (
    <div style={{ padding: "1rem", maxWidth: 900, margin: "0 auto" }}>
      <h1>Same-Day Trades</h1>
      <p style={{ fontStyle: "italic", color: "#555" }}>
        Mode: <strong>Same-Day Trades</strong> (future modes: Lunch, Snacks,
        Beer, Evening Out)
      </p>
      <p>
        1) Choose <strong>your name</strong> and confirm your contact info.
        2) Choose one of <strong>your future shifts</strong>. The app shows who
        else works that day and flags trades that create a{" "}
        <strong>SHORT TURNAROUND (&lt; 12h)</strong> for either doctor.
      </p>

      {error && <p style={{ color: "red" }}>{error}</p>}

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

      {/* Contact registration / editing for selected doctor */}
      {selectedDoctor && (
        <>
          <hr />
          <h2>Contact registration for Metri-Manager</h2>
          <p>
            You are editing contact info for:{" "}
            <strong>Dr. {selectedDoctor}</strong>
          </p>
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            Your current preference: <strong>{myPreferenceText}</strong>
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
                  setContactDraft((c) => ({ ...c, preferred: "email" }))
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
                  setContactDraft((c) => ({ ...c, preferred: "sms" }))
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
                  setContactDraft((c) => ({ ...c, preferred: "either" }))
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
                  setContactDraft((c) => ({ ...c, preferred: "none" }))
                }
              />
              &nbsp;I prefer not to share
            </label>
          </div>
          <button
            type="button"
            onClick={handleSaveContact}
            style={{ padding: "0.4rem 0.8rem", marginBottom: "0.5rem" }}
          >
            Save contact info
          </button>
          {contactSavedMessage && (
            <div style={{ color: "green", marginBottom: "0.5rem" }}>
              {contactSavedMessage}
            </div>
          )}
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            By entering my email and/or phone number and clicking Save, I
            consent to this site storing my contact information so that other
            users can contact me for shift trades.
          </p>
        </>
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
            <strong>Your shift:</strong> {myShift.date} {myShift.shiftName} (
            {myShift.startTime}–{myShift.endTime})
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
