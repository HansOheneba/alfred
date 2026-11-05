import { describe, expect, it } from "vitest";

import { SHEET_CLOSE_DISTANCE, sheetShouldClose } from "@/app/components/sheet-drag";

describe("pulling a phone sheet down", () => {
  it("closes after a long enough pull, however slow", () => {
    expect(sheetShouldClose(SHEET_CLOSE_DISTANCE, 0)).toBe(true);
    expect(sheetShouldClose(SHEET_CLOSE_DISTANCE - 1, 0.1)).toBe(false);
  });

  it("closes on a quick flick from a short pull", () => {
    expect(sheetShouldClose(40, 0.8)).toBe(true);
  });

  it("ignores a tiny twitch, even a fast one", () => {
    expect(sheetShouldClose(10, 2)).toBe(false);
  });

  it("snaps back when the finger was moving up at the end", () => {
    expect(sheetShouldClose(60, -0.4)).toBe(false);
  });
});
