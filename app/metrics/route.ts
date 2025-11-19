// app/api/metrics/route.ts
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

const VALID_MODES = ["sameDay", "getTogether", "periHang", "tradeFishing"] as const;
type UsageMode = (typeof VALID_MODES)[number];

type InsertBody = {
  mode: UsageMode;
  timestamp?: string;
  doctorName?: string;
  extra?: string;
};

// Ensure table exists before any query
async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS metri_manager_usage (
      id BIGSERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      doctor_name TEXT,
      extra TEXT
    );
  `;
}

// POST /api/metrics  -> log one event
export async function POST(req: Request) {
  try {
    await ensureTable();
    const body = (await req.json()) as InsertBody;

    if (!body.mode || !VALID_MODES.includes(body.mode)) {
      return NextResponse.json(
        { error: "Invalid or missing 'mode'" },
        { status: 400 }
      );
    }

    const ts = body.timestamp
      ? new Date(body.timestamp)
      : new Date();

    if (Number.isNaN(ts.getTime())) {
      return NextResponse.json(
        { error: "Invalid timestamp" },
        { status: 400 }
      );
    }

    await sql`
      INSERT INTO metri_manager_usage (mode, timestamp, doctor_name, extra)
      VALUES (${body.mode}, ${ts.toISOString()}, ${body.doctorName ?? null}, ${
      body.extra ?? null
    });
    `;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Error in POST /api/metrics:", err);
    return NextResponse.json(
      { error: "Failed to log event" },
      { status: 500 }
    );
  }
}

// GET /api/metrics  -> totals + recent events
export async function GET() {
  try {
    await ensureTable();

    const totalsRes = await sql<{
      mode: UsageMode;
      count: string;
    }>`
      SELECT mode, COUNT(*)::bigint AS count
      FROM metri_manager_usage
      GROUP BY mode;
    `;

    const totals: Record<UsageMode, number> = {
      sameDay: 0,
      getTogether: 0,
      periHang: 0,
      tradeFishing: 0,
    };

    for (const row of totalsRes.rows) {
      if (VALID_MODES.includes(row.mode)) {
        totals[row.mode] = Number(row.count);
      }
    }

    const eventsRes = await sql<{
      id: string;
      mode: UsageMode;
      timestamp: string;
      doctor_name: string | null;
      extra: string | null;
    }>`
      SELECT id, mode, timestamp, doctor_name, extra
      FROM metri_manager_usage
      ORDER BY timestamp DESC
      LIMIT 100;
    `;

    const events = eventsRes.rows.map((r) => ({
      id: r.id,
      mode: r.mode,
      timestamp: r.timestamp,
      doctorName: r.doctor_name,
      extra: r.extra,
    }));

    return NextResponse.json({ totals, events });
  } catch (err) {
    console.error("Error in GET /api/metrics:", err);
    return NextResponse.json(
      { error: "Failed to load metrics" },
      { status: 500 }
    );
  }
}
