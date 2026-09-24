import { digest } from "../workspace/registry";

export function reminderKey(ownerId: string, ruleId: string, subject: string) {
  return digest({ ownerId, ruleId, subject, channel: "desktop" });
}

export function deliveryKey(
  logicalKey: string,
  generation: number,
  resend: boolean,
) {
  return resend ? digest({ logicalKey, generation }) : logicalKey;
}

export function localDay(at: number, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function localClock(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  return `${parts.find((p) => p.type === "hour")?.value}:${parts.find((p) => p.type === "minute")?.value}`;
}

// Resolve wall time without relying on the service host's timezone. On fall-back days,
// choose the first occurrence; spring-forward gaps have no instant and are skipped.
export function resolveWall(day: string, clock: string, timezone: string) {
  const naive = Date.parse(`${day}T${clock}:00Z`);
  if (!Number.isFinite(naive)) return null;
  for (let offset = 14 * 60; offset >= -14 * 60; offset -= 15) {
    const instant = naive - offset * 60_000;
    if (
      localDay(instant, timezone) === day &&
      localClock(instant, timezone) === clock
    )
      return instant;
  }
  return null;
}

export function inQuietHours(
  clock: string,
  start: string | null,
  end: string | null,
) {
  if (!start || !end || start === end) return false;
  return start < end
    ? clock >= start && clock < end
    : clock >= start || clock < end;
}
