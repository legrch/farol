import type { Clock } from "../../../../pkg/kernel/app/clock";

export const readChatClock = (clock: Clock): number => clock.now();
