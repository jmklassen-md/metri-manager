"use client";

import React, { useEffect, useMemo, useState } from "react";

// ---------- Shared types ----------

type Shift = {
  date: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  doctor: string;
  location?: string;
  raw?: string;
};

type UsageMode = "sameDay" | "getTogether" | "periHang" | "tradeFishing";

type ModeUsageEvent = {
  id: string;
  mode: UsageMode;
  timestamp: string;
  doctorName?: string;
  extra?: string;
};

const ACCESS_CODE = process.env.NEXT_PUBLIC_ACCESS_CODE?.trim() || "";
const ACCESS_STORAGE_KEY = "metri-manager-access-ok";
const USAGE_LOG_KEY = "metriManagerUsageLog";

// ---------- Helpers ----------

function formatHumanDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function logModeUsage(event: ModeUsageEvent) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(USAGE_LOG_KEY);
    const arr = raw ? (JSON.parse(raw) as ModeUsageEvent[]) : [];
    arr.push(event);
    window.localStorage.setItem(USAGE_LOG_KEY, JSON.stringify(arr));
  } catch {
    // ignore
  }
}

// ---------- Page ----------

export default function TradeFishingPage() {
  const [hasAccess, setHasAccess] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [accessError, setAccessError] = useState("");

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedShiftIndex, setSelectedShiftIndex] = useState("");
  const [notes, setNotes] = useState(
    "Open to creative trades – nights for weekends, etc."
  );

  // Access gate: check existing access
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(ACCESS_STORAGE_KEY);
    if (stored === "yes") {
      setHasAccess(true);
    }
  }, []);

  const handleAccessSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const expected = ACCESS_CODE;

    if (!expected) {
      setHasAccess(true);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ACCESS_STORAGE_KEY, "yes");
      }
      return;
    }

    if (codeInput.trim() === expected) {
      setHasAccess(true);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ACCESS_STORAGE_KEY, "yes");
      }
      setAccessError("");
    } else {
      setAccessError("Access code is incorrect. Please try again.");
    }
  };

  // Load schedule
  useEffect(() => {
    if (!hasAccess) return;

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

        // Log that someone opened Trade Fishing (once we actually touched data)
        logModeUsage({
          id: makeId(),
          mode: "tradeFishing",
          timestamp: new Date().toISOString(),
        });
      })
      .catch(() => setError("Could not load schedule."));
  }, [hasAccess]);

  // Doctors list
  const doctors = useMemo(
    () =>
      Array.from(
        new Set(
          shifts
            .map((s) => (s.doctor || "").trim())
            .filter((n) => n.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [shifts]
  );

  // Future shifts for selected doctor
  const doctorFutureShifts = useMemo(() => {
    if (!selectedDoctor) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return shifts
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => {
        const docMatches =
          (s.doctor || "").trim().toLowerCase() ===
          selectedDoctor.trim().toLowerCase();
        if (!docMatches) return false;

        const d = new Date(s.date + "T00:00:00");
        return d >= today;
      });
  }, [selectedDoctor, shifts]);

  const myShift =
    selectedShiftIndex === ""
      ? null
      : shifts[parseInt(selectedShiftIndex, 10)] ?? null;

  // Build fishing message
  const buildFishingMessage = () => {
    if (!myShift || !selectedDoctor) return "";

    const meLabel = `Dr. ${selectedDoctor}`;
    const dateLabel = formatHumanDate(myShift.date);
    const shiftLabel = `${dateLabel}, ${myShift.shiftName} ${myShift.startTime}–${myShift.endTime}`;

    let body = `Hi everyone,\n\n${meLabel} is FISHING for a trade on this shift:\n\n`;
    body += `  • ${shiftLabel}\n\n`;
    body += `Notes / conditions:\n  • ${notes || "Flexible – open to ideas"}\n\n`;
    body +=
      "If you have a shift you’d consider trading, please reach out and we can see if something works.\n\n";
    body += "(Generated by Metri-Manager – Trade Fishing Marketplace.)";

    return body;
  };

  const handleOpenEmail = () => {
    if (!myShift || !selectedDoctor) return;
    const meLabel = `Dr. ${selectedDoctor}`;
    const subject = encodeURIComponent(
      `Trade fishing: ${meLabel} – ${formatHumanDate(
        myShift.date
      )} ${myShift.shiftName}`
    );
    const body = encodeURIComponent(buildFishingMessage());

    // No specific "to" – leave blank so they can choose the group
    const mailto = `mailto:?subject=${subject}&body=${body}`;
    window.location.href = mailto;

    logModeUsage({
      id: makeId(),
      mode: "tradeFishing",
      timestamp: new Date().toISOString(),
      doctorName: selectedDoctor,
      extra: "open-email",
    });
  };

  const handleCopyText = () => {
    const msg = buildFishingMessage();
    if (!msg) return;

    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(msg)
        .then(() => {
          alert(
            "Trade fishing text copied to clipboard.\nPaste it into an email, SMS, or chat."
          );
        })
        .catch(() => alert(msg));
    } else {
      alert(msg);
    }

    logModeUsage({
      id: makeId(),
      mode: "tradeFishing",
      timestamp: new Date().toISOString(),
      doctorName: selectedDoctor || undefined,
      extra: "copy-text",
    });
  };

  const handleBack = () => {
    if (typeof window !== "undefined") {
      window.location.href = "/";
    }
  };

  // ---------- ACCESS GATE ----------

  if (!hasAccess) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#101827",
          color: "#f9fafb",
          padding: "1rem",
        }}
      >
        <div
          style={{
            maxWidth: 400,
            width: "100%",
            padding: "1.5rem",
            borderRadius: 12,
            background: "#111827",
            boxShadow: "0 10px 25px rgba(0,0,0,0.4)",
            border: "1px solid #374151",
          }}
        >
          <h1 style={{ marginBottom: "0.5rem" }}>Metri-Manager</h1>
          <p
            style={{
              fontSize: "0.9rem",
              color: "#9ca3af",
              marginBottom: "1rem",
            }}
          >
            Please enter the SBH access code to continue.
          </p>

          <form onSubmit={handleAccessSubmit}>
            <input
              type="password"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="Access code"
              style={{
                width: "100%",
                padding: "0.6rem 0.8rem",
                borderRadius: 6,
                border: "1px solid #4b5563",
                background: "#020617",
                color: "#f9fafb",
                marginBottom: "0.75rem",
              }}
            />
            {accessError && (
              <div
                style={{
                  color: "#fca5a5",
                  marginBottom: "0.75rem",
                  fontSize: "0.85rem",
                }}
              >
                {accessError}
              </div>
            )}
            <button
              type="submit"
              style={{
                width: "100%",
                padding: "0.6rem 0.8rem",
                borderRadius: 6,
                border: "none",
                background: "#2563eb",
                color: "white",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Enter
            </button>
          </form>

          <p
            style={{
              marginTop: "0.75rem",
              fontSize: "0.75rem",
              color: "#6b7280",
            }}
          >
            For SBH Emergency Department staff only.
          </p>
        </div>
      </main>
    );
  }

  // ---------- MAIN RENDER ----------

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "0.5rem",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <div>
          <h1>Metri-Manager – Trade Fishing</h1>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#555" }}>
            Post a shift to the informal “marketplace” and see who bites.
          </p>
        </div>
        <button
          type="button"
          onClick={handleBack}
          style={{
            padding: "0.4rem 0.8rem",
            borderRadius: "999px",
            border: "1px solid #333",
            background: "#fff",
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          ← Back to Metri-Manager
        </button>
      </div>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <section
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          borderRadius: "0.5rem",
        }}
      >
        <h2>1. Pick your name</h2>
        {doctors.length === 0 && !error && <p>Loading schedule…</p>}
        {doctors.length > 0 && (
          <select
            value={selectedDoctor}
            onChange={(e) => {
              setSelectedDoctor(e.target.value);
              setSelectedShiftIndex("");
            }}
            style={{ width: "100%", padding: "0.5rem", marginBottom: "1rem" }}
          >
            <option value="">-- Choose your name --</option>
            {doctors.map((doc) => (
              <option key={doc} value={doc}>
                {doc}
              </option>
            ))}
          </select>
        )}

        <h2>2. Pick a future shift to fish</h2>
        {!selectedDoctor && <p>Select your name first.</p>}

        {selectedDoctor && doctorFutureShifts.length === 0 && (
          <p>No future shifts found for {selectedDoctor}.</p>
        )}

        {selectedDoctor && doctorFutureShifts.length > 0 && (
          <select
            value={selectedShiftIndex}
            onChange={(e) => setSelectedShiftIndex(e.target.value)}
            style={{ width: "100%", padding: "0.5rem", marginBottom: "1rem" }}
          >
            <option value="">-- Choose a shift to fish --</option>
            {doctorFutureShifts.map(({ s, index }) => {
              const label = `${formatHumanDate(
                s.date
              )}, ${s.shiftName} ${s.startTime}–${s.endTime}`;
              return (
                <option key={index} value={index}>
                  {label}
                </option>
              );
            })}
          </select>
        )}

        <h2>3. Add notes / conditions (optional)</h2>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          style={{ width: "100%", padding: "0.5rem", marginBottom: "1rem" }}
        />

        <h2>4. Generate your trade fishing message</h2>
        {!myShift && <p>Pick a shift above to generate text.</p>}

        {myShift && (
          <>
            <p style={{ fontSize: "0.9rem", color: "#555" }}>
              This text is designed to be pasted into an email, SMS, or group
              chat to see who might want to trade with you.
            </p>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                background: "#f3f4f6",
                padding: "0.75rem",
                borderRadius: "0.5rem",
                fontSize: "0.85rem",
                maxHeight: "300px",
                overflowY: "auto",
                marginBottom: "0.75rem",
              }}
            >
              {buildFishingMessage()}
            </pre>
            <div>
              <button
                type="button"
                onClick={handleOpenEmail}
                style={{
                  padding: "0.4rem 0.8rem",
                  marginRight: "0.5rem",
                  borderRadius: 6,
                  border: "1px solid #333",
                  background: "#1d4ed8",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Open email draft
              </button>
              <button
                type="button"
                onClick={handleCopyText}
                style={{
                  padding: "0.4rem 0.8rem",
                  borderRadius: 6,
                  border: "1px solid #333",
                  background: "#fff",
                  cursor: "pointer",
                }}
              >
                Copy text
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
