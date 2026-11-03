import { describe, expect, it } from "vitest";
import { classificationMeaning } from "@/lib/bank/purpose";

describe("purpose meaning excludes generated source descriptions", () => {
  it.each(["Money received", "GCB card top-up", "GCB card payment", "Into MobileMoney", "From Sample Sender", "Payment received from Sample Sender", "Sample Sender"])("does not treat %s as a reason for payment", (description) => {
    expect(classificationMeaning("Other", description, "Sample Sender")).toBeNull();
    expect(classificationMeaning("Salary", description, "Sample Sender")).toEqual({ category: "Salary", detail: null });
  });
  it("retains a specific saved reason under Other", () => {
    expect(classificationMeaning("Other", "Sale of my old desk")).toEqual({ category: "Other", detail: "Sale of my old desk" });
  });
});
