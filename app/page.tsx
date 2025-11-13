"use client";

import { useEffect, useMemo, useState } from "react";

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
  return new Date(`${date}T${time || "00:00"}:00`);
}

function getShiftDateTimes(shift: Shift): { start: Date; end: Date } {
  const start = toDateTime(shift.date, shift.startTime);
  let end = toDateTime(shift.date, shift.endTime);
  if (shift.endTime && shift.startTime && end <= start) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  return { start, end };
}

function findPreviousShiftEnd(
  allShifts: Shift[],
  doctor: string,
  referenceStart: Date
): Date | null {
  const candidates: Date[] = [];
  for (const s of allShifts) {
    if (!doctor || !s.doctor || s.doctor !== doctor) continue;
    const { end } = getShiftDateTimes(s);
    if (end < referenceStart) candidates.push(end);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.getTime() - a.getTime());
  return candidates[0];
}

function hoursDiff(later: Date, earlier: Date) {
  return (later.getTime() - earlier.getTime()) / (1000 * 60 * 60);
}

export default function Page() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [myShiftId, setMyShiftId] = useState("");

  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data: Shift[]) => {
        setShifts(data);
        if (data.length) {
          const earliest = [...new Set(data.map((s) => s.date))].sort()[0];
          setSelectedDate(earliest);
        }
      });
  }, []);

  const dates = useMemo(
    () => Array.from(new Set(shifts.map((s) => s.date))).sort(),
    [shifts]
  );

  const shiftsToday = shifts.filter((s) => s.date === selectedDate);

  const myShift =
    myShiftId !== ""
      ? shiftsToday.find((_, idx) => String(idx) === myShiftId)
      : null;

  const potentialTrades = useMemo(() => {
    if (!myShift) return [];
    const myDoc = myShift.doctor;
    const { start: myStart } = getShiftDateTimes(myShift);

    return shiftsToday
      .map((candidate, idx) => {
        if (candidate === myShift) return null;

        const candDoc = candidate.doctor;
        const { start: candStart } = getShiftDateTimes(candidate);

        let myFlag = false;
        let otherFlag = false;

        if (myDoc) {
          const myPrevEnd = findPreviousShiftEnd(shifts, myDoc, candStart);
          if (myPrevEnd) {
            const gap = hoursDiff(candStart, myPrevEnd);
            if (gap < 12) myFlag = true;
          }
        }

        if (candDoc) {
          const theirPrevEnd = findPreviousShiftEnd(shifts, candDoc, myStart);
          if (theirPrevEnd) {
            const gap = hoursDiff(myStart, theirPrevEnd);
            if (gap < 12) otherFlag = true;
          }
        }

        return {
          idx,
          candidate,
          hasShort: myFlag || otherFlag,
          who: { me: myFlag, them: otherFlag },
        };
      })
      .filter(Boolean) as Array<{
      idx: number;
      candidate: Shift;
      hasShort: boolean;
      who: { me: boolean; them: boolean };
    }>;
  }, [myShift, shiftsToday, shifts]);

  return (
    <div className="min-h-screen flex gap-4 p-4 bg-slate-50">
      <aside className="w-64 bg-white border rounded p-3 space-y-3">
        <h2 className="font-semibold mb-1">Dates</h2>
        <ul className="space-y-1 max-h-[60vh] overflow-y-auto">
          {dates.map((d) => (
            <li key={d}>
              <button
                onClick={() => {
                  setSelectedDate(d);
                  setMyShiftId("");
                }}
                className={`w-full text-left px-2 py-1 rounded ${
                  d === selectedDate ? "bg-slate-200" : ""
                }`}
              >
                {d}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="flex-1 space-y-5">
        <header>
          <h1 className="text-2xl font-bold">Shifts for {selectedDate || "—"}</h1>
          <p className="text-sm text-slate-500">
            Select your shift, then review same-day trade options. Trades that
            create &lt; 12h rest for either doctor are flagged.
          </p>
        </header>

        <section className="bg-white border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2 text-left">Mine?</th>
                <th className="p-2 text-left">Shift</th>
                <th className="p-2 text-left">Doctor</th>
                <th className="p-2 text-left">Start</th>
                <th className="p-2 text-left">End</th>
              </tr>
            </thead>
            <tbody>
              {shiftsToday.map((s, idx) => (
                <tr key={idx} className="border-b last:border-b-0">
                  <td className="p-2">
                    <input
                      type="radio"
                      name="myShift"
                      value={idx}
                      checked={myShiftId === String(idx)}
                      onChange={() => setMyShiftId(String(idx))}
                    />
                  </td>
                  <td className="p-2">{s.shiftName || s.raw}</td>
                  <td className="p-2">{s.doctor}</td>
                  <td className="p-2">{s.startTime}</td>
                  <td className="p-2">{s.endTime}</td>
                </tr>
              ))}
              {!shiftsToday.length && (
                <tr>
                  <td className="p-3" colSpan={5}>
                    No shifts today.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="bg-white border rounded p-3 space-y-3">
          <h2 className="font-semibold">Potential same-day trades</h2>
          {!myShift && (
            <p className="text-sm text-slate-500">
              Pick your shift above to see trade options.
            </p>
          )}
          {myShift && potentialTrades.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-2 text-left">Shift</th>
                  <th className="p-2 text-left">Doctor</th>
                  <th className="p-2 text-left">Start</th>
                  <th className="p-2 text-left">End</th>
                  <th className="p-2 text-left">Flags</th>
                </tr>
              </thead>
              <tbody>
                {potentialTrades.map((t) => (
                  <tr key={t.idx} className="border-b last:border-b-0">
                    <td className="p-2">
                      {t.candidate.shiftName || t.candidate.raw}
                    </td>
                    <td className="p-2">{t.candidate.doctor}</td>
                    <td className="p-2">{t.candidate.startTime}</td>
                    <td className="p-2">{t.candidate.endTime}</td>
                    <td className="p-2">
                      {t.hasShort ? (
                        <span className="inline-block px-2 py-1 text-xs bg-red-100 text-red-700 rounded">
                          SHORT TURNAROUND
                          {t.who.me ? " (you)" : ""}
                          {t.who.them ? " (other)" : ""}
                        </span>
                      ) : (
                        <span className="inline-block px-2 py-1 text-xs bg-emerald-50 text-emerald-700 rounded">
                          OK
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {myShift && !potentialTrades.length && (
            <p className="text-sm text-slate-500">
              No other shifts to trade with today.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
