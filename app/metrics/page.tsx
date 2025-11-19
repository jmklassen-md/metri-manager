"use client";

import React, { useEffect, useMemo, useState } from "react";

type UsageMode = "sameDay" | "getTogether" | "periHang" | "tradeFishing";

type ModeUsageEvent = {
  id: string;
  mode: UsageMode;
  timestamp: string;
  doctorName?: string;
  extra?: string;
};

const USAGE_LOG_KEY = "metriManagerUsageLog";

export default function MetricsPage() {
  const [events, setEvents] = useState<ModeUsageEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load from localStorage once on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(USAGE_LOG_KEY);
      if (!raw) {
        setEvents([]);
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setEvents(parsed);
      } else {
        setEvents([]);
      }
    } catch (e) {
      console.error("Failed to read usage log", e);
      setError("Could not read usage log from this browser.");
      setEvents([]);
    }
  }, []);

  const totals = useMemo(() => {
    const base = {
      sameDay: 0,
      getTogether: 0,
      periHang: 0,
      tradeFishing: 0,
    } as Record<UsageMode, number>;

    for (const ev of events) {
      if (ev.mode in base) {
        base[ev.mode as UsageMode] += 1;
      }
    }
    return base;
  }, [events]);

  const totalEvents = events.length;

  // Show most recent 50 events (newest first)
  const recentEvents = useMemo(() => {
    const sorted = [...events].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    return sorted.slice(-50).reverse();
  }, [events]);

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "1rem" }}>
      <h1>Metri-Manager – Usage Metrics</h1>
      <p style={{ maxWidth: 700, fontSize: "0.9rem", color: "#555" }}>
        These metrics are based on{" "}
        <strong>localStorage in this browser only</strong>. They do not merge
        across devices or users yet. If you open this page on another computer
        or browser, you&apos;ll see a different (often empty) log.
      </p>

      {error && (
        <p style={{ color: "red", marginTop: "0.5rem" }}>{error}</p>
      )}

      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1rem",
        }}
      >
        <h2>Mode usage counts</h2>
        <p style={{ fontSize: "0.9rem", color: "#555" }}>
          Total logged events in this browser:{" "}
          <strong>{totalEvents}</strong>
        </p>
        <div style={{ overflowX: "auto" }}>
          <table
            border={1}
            cellPadding={6}
            style={{
              borderCollapse: "collapse",
              minWidth: 400,
              marginTop: "0.5rem",
            }}
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
                <td>{totals.sameDay}</td>
              </tr>
              <tr>
                <td>Get Together</td>
                <td>{totals.getTogether}</td>
              </tr>
              <tr>
                <td>Peri-Shift Hang</td>
                <td>{totals.periHang}</td>
              </tr>
              <tr>
                <td>Trade Fishing</td>
                <td>{totals.tradeFishing}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginTop: "1rem",
          marginBottom: "2rem",
        }}
      >
        <h2>Recent events (this browser)</h2>
        {recentEvents.length === 0 && (
          <p style={{ fontSize: "0.9rem", color: "#555" }}>
            No events logged yet in this browser. Try using Same-Day Trades,
            Get Together, Peri-Shift Hang, or Trade Fishing, then reload this
            page.
          </p>
        )}
        {recentEvents.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table
              border={1}
              cellPadding={6}
              style={{
                borderCollapse: "collapse",
                minWidth: 600,
                marginTop: "0.5rem",
              }}
            >
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Mode</th>
                  <th>Doctor (if recorded)</th>
                  <th>Extra</th>
                </tr>
              </thead>
              <tbody>
                {recentEvents.map((ev) => (
                  <tr key={ev.id}>
                    <td>
                      {new Date(ev.timestamp).toLocaleString(undefined, {
                        dateStyle: "short",
                        timeStyle: "medium",
                      })}
                    </td>
                    <td>{ev.mode}</td>
                    <td>{ev.doctorName || "—"}</td>
                    <td>{ev.extra || "—"}</td>
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
