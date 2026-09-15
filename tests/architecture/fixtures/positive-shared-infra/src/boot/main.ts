import { readChatClock } from "../modules/chat/app/service/read-clock";
import { readReleaseClock } from "../modules/release/app/service/read-clock";
import { SystemClock } from "../pkg/kernel/infra/system-clock";

const chatClock = new SystemClock();
const releaseClock = new SystemClock();

export const readings = [
  readChatClock(chatClock),
  readReleaseClock(releaseClock),
];
