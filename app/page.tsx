"use client";

import React, { useEffect, useMemo, useState } from "react";

type Shift = {
  date: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  doctor: string;
  location?: string;
  raw?: string;
};

function toDateTime(date: string, time: string): Date {
  if (!date || !time) return new Date(NaN);
  return new Date(`${date}T${time}:00`);
}

function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = toDateTime(shift.date, shift.startTime);
  let end = toDateTime(shift.date, shift.endTime);

  if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }

  return { start, end };
}

function hoursDiff(later: Date, earlier: Date) {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60);
}

function findPreviousShiftEnd(
  allShifts: Shift[],
  doctor: string,
  referenceStart: Date
): Date | null {
  const ends: Date[] = [];

  for (const s of allShifts) {
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

export default function Page() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedShiftIndex, setSelectedShiftIndex] = useState("");

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
          `${a.date} ${a.startTime}`.localeCompare(
            `${b.date} ${b.startTime}`
          )
        );
        setShifts(sorted);
      })
      .catch(() => setError("Could not load schedule."));
  }, []);

  // All doctor names
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

  // Shifts for selected doctor
  const doctorShifts = useMemo(
    () =>
      shifts
        .map((s, index) => ({ s, index }))
        .filter(
          ({ s }) =>
            selectedDoctor &&
            (s.doctor || "").trim().toLowerCase() ===
              selectedDoctor.trim().toLowerCase()
        ),
    [selectedDoctor, shifts]
  );

  const myShift =
    selectedShiftIndex === ""
      ? null
      : shifts[parseInt(selectedShiftIndex, 10)];

  const sameDayShifts = useMemo(() => {
    if (!myShift) return [];
    return shifts.filter((s) => s.date === myShift.date);
  }, [myShift,
