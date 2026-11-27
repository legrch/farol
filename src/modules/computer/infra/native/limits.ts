// Byte limits shared by request checks and helper reply checks.

export const MAX_SOURCE_BYTES = 256 * 1024;

// A window returns no more than a whole read may and spans at least one whole
// UTF-8 character (at most four bytes), so each window's `nextOffset` lies
// past its own offset. Its offset is any exact integer: the helper accepts
// every offset up to 2^53 - 1, so a reported `nextOffset` is always a valid
// next request, however large the file.
export const MIN_WINDOW_BYTES = 4;

export const MAX_MUTATION_BYTES = 8 * 1024 * 1024;
