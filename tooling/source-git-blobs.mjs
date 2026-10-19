// Git's batch protocol is length framed: blob bytes can contain newlines, NULs,
// and text resembling headers. Never split the body into text records.
const batchLimit = 16 * 1024 * 1024;
const objectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function invalid() {
  throw new Error("SOURCE_GIT_BATCH_INVALID");
}

function headerAt(bytes, offset, objectId) {
  const end = bytes.indexOf(10, offset);
  if (end < offset || end - offset > 128) invalid();
  const header = bytes.subarray(offset, end).toString("utf8");
  const match = /^([a-f0-9]+) blob (0|[1-9][0-9]*)$/u.exec(header);
  if (!match || match[1] !== objectId) invalid();
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size)) invalid();
  return { size, next: end + 1 };
}

export function parseBlobSizes(bytes, objectIds) {
  let offset = 0;
  const sizes = new Map();
  for (const objectId of objectIds) {
    const header = headerAt(bytes, offset, objectId);
    sizes.set(objectId, header.size);
    offset = header.next;
  }
  if (offset !== bytes.length) invalid();
  return sizes;
}

export function parseBlobBatch(bytes, objectIds, sizes) {
  let offset = 0;
  const blobs = new Map();
  for (const objectId of objectIds) {
    const header = headerAt(bytes, offset, objectId);
    if (header.size !== sizes.get(objectId)) invalid();
    const end = header.next + header.size;
    if (!Number.isSafeInteger(end) || end >= bytes.length || bytes[end] !== 10)
      invalid();
    blobs.set(objectId, bytes.subarray(header.next, end));
    offset = end + 1;
  }
  if (offset !== bytes.length) invalid();
  return blobs;
}

// The caller owns the fixed Git executable/environment. This helper only reads
// explicitly requested HEAD objects, never all objects or filesystem filters.
// A failed batch is a failure; it is never retried through another route.
export function readGitBlobs(objectIds, git) {
  const unique = [...new Set(objectIds)];
  if (unique.some((id) => !objectIdPattern.test(id))) invalid();
  if (unique.length === 0) return new Map();
  const request = (ids) => Buffer.from(`${ids.join("\n")}\n`);
  const sizes = parseBlobSizes(
    git(["cat-file", "--batch-check"], request(unique)),
    unique,
  );
  const blobs = new Map();
  let chunk = [];
  let chunkBytes = 0;
  const flush = () => {
    if (!chunk.length) return;
    const result = parseBlobBatch(
      git(["cat-file", "--batch"], request(chunk)),
      chunk,
      sizes,
    );
    for (const [id, bytes] of result) blobs.set(id, bytes);
    chunk = [];
    chunkBytes = 0;
  };
  for (const id of unique) {
    const size = sizes.get(id);
    // Preserve the existing individual-object buffer limit for large objects;
    // adding framing must not reject a blob the original reader could read.
    if (size + 128 > batchLimit) {
      flush();
      const bytes = git(["cat-file", "blob", id]);
      if (bytes.length !== size) invalid();
      blobs.set(id, bytes);
      continue;
    }
    if (chunkBytes + size + 128 > batchLimit) flush();
    chunk.push(id);
    chunkBytes += size + 128;
  }
  flush();
  return blobs;
}
