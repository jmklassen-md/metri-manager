"use client";

import React, { useEffect, useState } from "react";

type UsageMode = "sameDay" | "getTogether" | "periHang" | "tradeFishing";

type MetricsTotals = Record<UsageMode, number>;

type MetricsEvent = {
  id: string;
  mode: UsageMode;
  timestamp: string;
  doctorName?: string | null;
  extra?: string | null;
};

type MetricsResponse = {
  totals: MetricsTotals;
  events: MetricsEvent[];
};

export default function MetricsPage() {
  const [totals, setTotals] = useState<MetricsTotals>({
    sameDay: 0,
    getTogether: 0,
    periHang: 0,
    tradeFishing: 0,
  });
  const [events, setEvents] = useState<MetricsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadMetrics() {
      try {
        const res = await fetch("/api/metrics", { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as MetricsResponse;
        setTotals(data.totals);
        setEvents(data.events);
      } catch (e) {
        console.error("Failed to load metrics", e);
        setError("Could not load metrics from the server.");
      } finally {
        setLoading(false);
      }
    }
    loadMetrics();
  }, []);

  const totalEvents =
    totals.sameDay +
    totals.getTogether +
    totals.periHang +
    totals.tradeFishing;

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "1rem" }}>
      <h1>Metri-Manager – Global Usage Metrics</h1>
      <p style={{ maxWidth: 700, fontSize: "0.9rem", color: "#555" }}>
        These stats come from the shared Metri-Manager database and include{" "}
        <strong>all users</strong> on this deployment (not just your browser).
      </p>

      {loading && <p>Loading metrics…</p>}
      {error && (
        <p style={{ color: "red", marginTop: "0.5rem" }}>{error}</p>
      )}

      {!loading && !error && (
        <>
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
              Total logged events: <strong>{totalEvents}</strong>
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
            <h2>Recent usage events (all users)</h2>
            {events.length === 0 && (
              <p style={{ fontSize: "0.9rem", color: "#555" }}>
                No events have been logged yet. Once users start using the
                modes, they will appear here.
              </p>
            )}
            {events.length > 0 && (
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
                    {events.map((ev) => (
                      <tr key={ev.id}>
                        <td>
                          {new Date(ev.timestamp).toLocaleString(
                            undefined,
                            {
                              dateStyle: "short",
                              timeStyle: "medium",
                            }
                          )}
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
        </>
      )}
    </main>
  );
}
