// One value that two owners share by reference. The owner that creates it
// exposes the cell; a reader calls `get()` at the moment it needs the value, so
// a change made in between is seen, and a writer calls `set()`. Nothing here
// observes, validates or clones the value.

export type Cell<T> = Readonly<{
  get: () => T;
  set: (value: T) => void;
}>;

export function createCell<T>(initial: T): Cell<T> {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}
