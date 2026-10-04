/** Recipient-local send windows and weekday weights. */

export interface SendWindow {
  startMin: number; // minutes from local midnight
  endMin: number;
  weight: number;
}

const hm = (h: number, m: number) => h * 60 + m;

export const DEFAULT_WINDOWS: SendWindow[] = [
  { startMin: hm(8, 30), endMin: hm(11, 30), weight: 0.5 },
  { startMin: hm(13, 0), endMin: hm(16, 30), weight: 0.35 },
  { startMin: hm(16, 30), endMin: hm(18, 0), weight: 0.15 },
];

/** Weekday weights, luxon convention 1=Mon..7=Sun. */
export const DEFAULT_WEEKDAY_WEIGHTS: Record<number, number> = {
  1: 0.75, // Mon
  2: 1.0, // Tue
  3: 1.0, // Wed
  4: 1.0, // Thu
  5: 0.6, // Fri
  6: 0, // Sat
  7: 0, // Sun
};

export function weekdayWeight(
  weekday: number,
  weights: Record<number, number> = DEFAULT_WEEKDAY_WEIGHTS,
): number {
  return weights[weekday] ?? 0;
}
