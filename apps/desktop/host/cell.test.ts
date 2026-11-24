import { describe, expect, it } from "vitest";
import { createCell } from "./cell";

describe("createCell", () => {
  it("starts with its initial value", () => {
    expect(createCell<number | null>(null).get()).toBeNull();
    expect(createCell("first").get()).toBe("first");
  });

  it("returns the last value set, by identity", () => {
    const first = { id: 1 };
    const second = { id: 2 };
    const cell = createCell<{ id: number } | null>(first);
    expect(cell.get()).toBe(first);
    cell.set(second);
    expect(cell.get()).toBe(second);
    cell.set(null);
    expect(cell.get()).toBeNull();
  });

  it("keeps cells independent", () => {
    const left = createCell(1);
    const right = createCell(1);
    left.set(2);
    expect(right.get()).toBe(1);
  });

  it("lets a reader holding a getter see a later write", () => {
    const cell = createCell<string | null>(null);
    const read = () => cell.get();
    expect(read()).toBeNull();
    cell.set("later");
    expect(read()).toBe("later");
  });

  it("shares one value between two holders of the same cell", () => {
    const owner = createCell<number>(0);
    const reader = owner;
    reader.set(5);
    expect(owner.get()).toBe(5);
  });
});
