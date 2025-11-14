import { Pool } from "pg";

if (!process.env.POSTGRES_URL) {
  throw new Error("POSTGRES_URL is not set in environment variables.");
}

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

export async function getContact(doctorName: string) {
  const res = await pool.query(
    "SELECT doctor_name, email, phone, preferred FROM contacts WHERE doctor_name = $1",
    [doctorName]
  );
  return res.rows[0] || null;
}

export async function upsertContact(options: {
  doctorName: string;
  email: string;
  phone: string;
  preferred: string;
}) {
  const { doctorName, email, phone, preferred } = options;
  await pool.query(
    `
    INSERT INTO contacts (doctor_name, email, phone, preferred)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (doctor_name)
    DO UPDATE SET email = EXCLUDED.email,
                  phone = EXCLUDED.phone,
                  preferred = EXCLUDED.preferred
  `,
    [doctorName, email, phone, preferred]
  );
}

export async function getAllContacts() {
  const res = await pool.query(
    "SELECT doctor_name, email, phone, preferred FROM contacts"
  );
  return res.rows;
}
