import { NextResponse } from "next/server";
import { pool } from "@/app/lib/db";

export async function GET() {
  try {
    const { rows } = await pool.query("SELECT * FROM contacts ORDER BY doctor_name ASC");
    return NextResponse.json(rows);
  } catch (err) {
    console.error("GET contacts error:", err);
    return NextResponse.json({ error: "Failed to fetch contacts" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const data = await req.json();
    const { doctor_name, email, phone, preferred } = data;

    await pool.query(
      `INSERT INTO contacts (doctor_name, email, phone, preferred)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (doctor_name)
       DO UPDATE SET email=$2, phone=$3, preferred=$4`,
      [doctor_name, email, phone, preferred]
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("POST contacts error:", err);
    return NextResponse.json({ error: "Failed to save contact" }, { status: 500 });
  }
}
