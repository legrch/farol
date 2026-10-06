import { observeUpdateSlot } from "./update-slot-observer.mjs";

const [slot] = process.argv.slice(2);
if (process.argv.length !== 3) throw new Error("UPDATE_SLOT_INVALID");
process.stdout.write(JSON.stringify(await observeUpdateSlot(slot)));
