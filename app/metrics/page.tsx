"use client";

import React, { useEffect, useMemo, useState } from "react";

type UsageMode = "sameDay" | "getTogether" | "periHang" | "tradeFishing";

type ModeUsageDetails = {
  selectedDoctor?: string;
  groupDoctors?: string[];
  periDoctors?: string[];
};

type ModeUsageEvent = {
  mode: UsageMode;
  timestamp: string; // ISO
  details?: ModeUsageDetails;
};

const USAGE_STORAGE_KEY = "metriManagerModeUsage";

function formatTimestamp(ts: string) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function describeDetails(e: ModeUsageEvent): string {
  const parts: string[] = [];

  if (e.details?.selectedDoctor) {
    parts.push(`Dr. ${e.details.selectedDoctor}`);
  }
  if (e.details?.groupDoctors?.length) {
    parts.push(`Group: ${e.details.groupDoctors.join(", ")}`);
  }
  if (e.details?.periDoctors?.length) {
    parts.push(`Peri group: ${e.details.periDoctors.join(", ")}`);
  }

  return parts.join(" | ") || "N/A";
}

export default function MetricsPage() {
  const [events, setEvents] = useState<ModeUsageEvent[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(USAGE_STORAGE_KEY);
      const parsed: ModeUsageEvent[] = raw ? JSON.parse(raw) : [];
      setEvents(parsed);
    } catch {
      setEvents([]);
    }
  }, []);

  const counts = useMemo(() => {
    const base: Record<UsageMode, number> = {
      sameDay: 0,
      getTogether: 0,
      periHang: 0,
      tradeFishing: 0,
    };
    for (const e of events) {
      base[e.mode] = (base[e.mode] || 0) + 1;
    }
    return base;
  }, [events]);

  const sortedEvents = useMemo(
    () =>
      [...events].sort(
        (a, b) =>
          new Date(b.timestamp).getTime() -
          new Date(a.timestamp).getTime()
      ),
    [events]
  );

  const handleClear = () => {
    if (typeof window === "undefined") return;
    const ok = window.confirm(
      "Clear all Metri-Manager usage data on this browser?"
    );
    if (!ok) return;
    window.localStorage.removeItem(USAGE_STORAGE_KEY);
    setEvents([]);
  };

  const handleBackHome = () => {
    if (typeof window !== "undefined") {
      window.location.href = "/";
    }
  };

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "1rem" }}>
      <h1>Metri-Manager – Usage Metrics</h1>
      <p style={{ marginBottom: "0.5rem" }}>
        Local statistics for this browser. For system-wide analytics you’d
        wire these events into a backend instead of localStorage.
      </p>

      <div style={{ marginBottom: "1rem" }}>
        <button
          type="button"
          onClick={handleBackHome}
          style={{
            padding: "0.4rem 0.8rem",
            marginRight: "0.5rem",
            borderRadius: "999px",
            border: "1px solid #333",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          ← Back to Metri-Manager
        </button>
        <button
          type="button"
          onClick={handleClear}
          style={{
            padding: "0.4rem 0.8rem",
            borderRadius: "999px",
            border: "1px solid #b91c1c",
            background: "#fee2e2",
            color: "#991b1b",
            cursor: "pointer",
          }}
        >
          Clear local log
        </button>
      </div>

      {/* Summary counts */}
      <section
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          borderRadius: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        <h2>Mode Usage Counts</h2>
        <table
          border={1}
          cellPadding={6}
          style={{ borderCollapse: "collapse", minWidth: 300 }}
        >
          <thead>
            <tr>
              <th>Mode</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Same-Day Trades</td>
              <td>{counts.sameDay}</td>
            </tr>
            <tr>
              <td>Get Together</td>
              <td>{counts.getTogether}</td>
            </tr>
            <tr>
              <td>Peri-Shift Hang</td>
              <td>{counts.periHang}</td>
            </tr>
            <tr>
              <td>Trade Fishing</td>
              <td>{counts.tradeFishing}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Detailed log */}
      <section
        style={{
          border: "1px solid #ccc",
          padding: "1rem",
          borderRadius: "0.5rem",
        }}
      >
        <h2>Usage Log</h2>
        {sortedEvents.length === 0 && <p>No events logged yet.</p>}
        {sortedEvents.length > 0 && (
          <div style={{ maxHeight: 400, overflowY: "auto" }}>
            <table
              border={1}
              cellPadding={6}
              style={{ borderCollapse: "collapse", minWidth: 600 }}
            >
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Mode</th>
                  <th>Who / Context</th>
                </tr>
              </thead>
              <tbody>
                {sortedEvents.map((e, idx) => (
                  <tr key={idx}>
                    <td>{formatTimestamp(e.timestamp)}</td>
                    <td>{e.mode}</td>
                    <td>{describeDetails(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
