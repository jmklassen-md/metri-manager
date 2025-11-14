import { NextRequest, NextResponse } from "next/server";
import {
  getAllContacts,
  getContact,
  upsertContact,
} from "../../../lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const doctor = searchParams.get("doctor");

  try {
    if (doctor) {
      const contact = await getContact(doctor);
      return NextResponse.json(contact || null);
    } else {
      const contacts = await getAllContacts();
      return NextResponse.json(contacts);
    }
  } catch (err) {
    console.error("GET /api/contacts error:", err);
    return NextResponse.json(
      { error: "Failed to fetch contacts" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const doctorName = (body.doctorName || "").trim();
    const email = (body.email || "").trim();
    const phone = (body.phone || "").trim();
    const preferred = (body.preferred || "none").trim();

    if (!doctorName) {
      return NextResponse.json(
        { error: "doctorName is required" },
        { status: 400 }
      );
    }

    await upsertContact({ doctorName, email, phone, preferred });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/contacts error:", err);
    return NextResponse.json(
      { error: "Failed to save contact" },
      { status: 500 }
    );
  }
}
