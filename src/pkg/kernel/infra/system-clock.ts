import type { Clock } from "../app/clock";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
