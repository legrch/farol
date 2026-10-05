import { expect, it } from "vitest";

// C09 runner probe: this fixture must be selected and executed by the main
// Vitest configuration outside the renderer directory. It launches no browser
// and is not an assembled-product or native evidence claim.
it("C09 executes a TSX fixture through the main test runner", () => {
  const marker = <span data-test-scope="fixture">TSX fixture executed</span>;
  expect(marker.type).toBe("span");
  expect(marker.props).toEqual({
    "data-test-scope": "fixture",
    children: "TSX fixture executed",
  });
});
