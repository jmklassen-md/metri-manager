import { NextRequest, NextResponse } from "next/server";
import {
  getAllContacts,
  getContact,
  upsertContact,
} from "@/lib/db";

// GET /api/contacts
// Optional: ?doctor=Klassen  -> returns single contact
// Otherwise returns all contacts
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const doctor = searchParams.get("doctor");

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

// POST /api/contacts
// Body: { doctorName, email, phone, preferred }
export async function POST(req: NextRequest) {
  try {
    const { doctorName, email, phone, preferred } = await req.json();

    if (!doctorName) {
      return NextResponse.json(
        { error: "doctorName is required" },
        { status: 400 }
      );
    }

    await upsertContact({
      doctorName,
      email: email || "",
      phone: phone || "",
      preferred: preferred || "none",
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("POST /api/contacts error:", err);
    return NextResponse.json(
      { error: "Failed to save contact" },
      { status: 500 }
    );
  }
}
