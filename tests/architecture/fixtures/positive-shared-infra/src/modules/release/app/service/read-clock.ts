import type { Clock } from "../../../../pkg/kernel/app/clock";

export const readReleaseClock = (clock: Clock): number => clock.now();
