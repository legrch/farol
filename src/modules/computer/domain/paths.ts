// Containment is decided once, in the shared kernel, so every module treats
// the filesystem root the same way. See `pkg/kernel/domain/within`.
export {
  comparableWithin,
  isCanonicalAbsolutePath,
  isWithin,
} from "../../../pkg/kernel/domain/within";
