// Squaredle publishes the next daily board at 03:00 in Los Angeles.
const pacific = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

export function puzzleDateAt(time = Date.now()) {
  const p = Object.fromEntries(pacific.formatToParts(new Date(time)).map(p => [p.type, p.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return Number(p.hour) >= 3 ? date
    : new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

const endTimes = new Map();
export function puzzleEndsAt(date) {
  if (endTimes.has(date)) return endTimes.get(date);
  // Find the first millisecond of the following puzzle day. Searching the
  // timezone calendar also handles the 23/25-hour days at DST transitions.
  let lo = Date.parse(`${date}T00:00:00Z`);
  let hi = lo + 2 * 86400000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (puzzleDateAt(mid) <= date) lo = mid + 1;
    else hi = mid;
  }
  endTimes.set(date, lo);
  return lo;
}

// Align checks to the wall clock, rather than to when the server started.
export function nextPuzzleRefreshAt(time = Date.now()) {
  const hour = 60 * 60 * 1000;
  let hourly = Math.floor(time / hour) * hour + 20000;
  if (hourly <= time) hourly += hour;
  return Math.min(hourly, puzzleEndsAt(puzzleDateAt(time)));
}
