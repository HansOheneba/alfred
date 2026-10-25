import { describe, expect, it } from "vitest";

import { isOwnName, parseBankText, payeeKey } from "@/lib/bank/parse";

const now = new Date("2026-10-25T09:00:00.000Z");
const options = { now, timeZone: "Africa/Accra" };

const MOMO_OUT =
  "Payment made for GHS 18.50 to RUKAYA ISSIFU Current Balance: GHS 610.40 . Available Balance: GHS 610.40. Reference: G. Transaction ID: 90806991210. Fee charged: GHS0.38 Tax charged: 0. Download the MoMo App for a Faster & Easier Experience. Click here: https://mtnmymomo.onelink.me/XJOt/MoMo";
const MOMO_IN =
  "Payment received for GHS 500.00 from HANS OHENEBA ADUSE OPOKU Current Balance: GHS 618.03 . Available Balance: GHS 618.03. Reference: HANS OHENEBA ADUSE OPOKU ,10xxxxxx87,GIPS Transfer from GCB Bank. Transaction ID: 90803989481. TRANSACTION FEE: 0.00";
const LOAN_IN =
  "Payment received for GHS 515.00 from Loan  Account  Current Balance: GHS 629.28 . Available Balance: GHS 629.28. Reference: . Transaction ID: 90804260790. TRANSACTION FEE: 0.00";
const GCB_DEBIT =
  "Dear HANS OHENEBA ADUSE OPOKU. Your Prepaid Card VISA VPREPAID CLASSIC has been debited with  amount of : 62.73 GHANA CEDIS. Your balance is 7.35 GHANA CEDIS. Please call 0800422422 for assistance";
const GCB_ZERO =
  "Dear HANS OHENEBA ADUSE OPOKU. Your Prepaid Card VISA VPREPAID CLASSIC has been debited with  amount of : 0.00 GHANA CEDIS. Your balance is 7.35 GHANA CEDIS. Please call 0800422422 for assistance";
const GCB_CREDIT =
  "Dear HANS OHENEBA ADUSE OPOKU. Your Prepaid Card  has been credited with an amount of : 66.82 GHS. Your balance is 74.17 GHS. Please call 0800422422 for assistance";

describe("bank message parser", () => {
  it("reads a MoMo payment with its fee, balance and transaction id", () => {
    const [message] = parseBankText(MOMO_OUT, options);
    expect(message).toMatchObject({
      source: "momo",
      direction: "out",
      amount: "18.50",
      fee: "0.38",
      counterparty: "RUKAYA ISSIFU",
      balance: "610.40",
      externalId: "90806991210",
    });
  });

  it("reads money received and keeps the reference for own-transfer checks", () => {
    const [message] = parseBankText(MOMO_IN, options);
    expect(message).toMatchObject({ direction: "in", amount: "500.00", counterparty: "HANS OHENEBA ADUSE OPOKU", externalId: "90803989481" });
    expect(message.reference).toContain("GCB Bank");
  });

  it("reads a loan account deposit", () => {
    const [message] = parseBankText(LOAN_IN, options);
    expect(message).toMatchObject({ direction: "in", amount: "515.00", counterparty: "Loan Account" });
  });

  it("reads GCB card debits and credits and skips zero-amount ones", () => {
    expect(parseBankText(GCB_DEBIT, options)[0]).toMatchObject({ source: "gcb", direction: "out", amount: "62.73", balance: "7.35" });
    expect(parseBankText(GCB_CREDIT, options)[0]).toMatchObject({ source: "gcb", direction: "in", amount: "66.82", balance: "74.17" });
    expect(parseBankText(GCB_ZERO, options)).toHaveLength(0);
  });

  it("ignores promotions and notices", () => {
    expect(parseBankText("Dear Customer, You're at the heart of all we do. This Customer Service Month, we celebrate you.", options)).toHaveLength(0);
    expect(parseBankText("Hello, The requested link to account: 830638475178 at OPSWALLET-PERSONAL has been added.", options)).toHaveLength(0);
  });

  it("splits a screenshot's text into messages and dates them from the headers", () => {
    const screenshot = [
      "Sun, 4 Oct at 8:15 AM",
      MOMO_OUT,
      "Mon, 5 Oct at 7:54 AM",
      "Payment made for GHS 25.50 to ADISAH ANABZO Current Balance: GHS 584.90 . Available Balance: GHS 584.90. Reference: . Transaction ID: 90867206914. Fee charged: GHS0.00 Tax charged: 0.",
      "Dear Customer, You're at the heart of all we do.",
    ].join("\n");
    const messages = parseBankText(screenshot, options);
    expect(messages.map((item) => [item.counterparty, item.amount, item.occurredAt])).toEqual([
      ["RUKAYA ISSIFU", "18.50", "2026-10-04T08:15:00.000Z"],
      ["ADISAH ANABZO", "25.50", "2026-10-05T07:54:00.000Z"],
    ]);
  });

  it("dates a message above the first readable heading from the heading below it", () => {
    const messages = parseBankText(`${MOMO_IN}\nSun, 4 Oct at 8:15 AM\n${MOMO_OUT}`, options);
    expect(messages.map((item) => item.occurredAt)).toEqual(["2026-10-04T08:14:00.000Z", "2026-10-04T08:15:00.000Z"]);
  });

  it("gives an SMS and a screenshot of it the same fingerprint", () => {
    const sms = parseBankText(GCB_DEBIT, options)[0];
    const ocr = parseBankText(`Mon, 5 Oct at 1:06 AM ${GCB_DEBIT.replace(/\s+/g, " ")}`, options)[0];
    expect(ocr.fingerprint).toBe(sms.fingerprint);
  });

  it("recognises the person's own names", () => {
    expect(isOwnName("HANS OHENEBA ADUSE OPOKU", ["Hans Oheneba Adusé Opoku"])).toBe(true);
    expect(isOwnName("HANS OHENEBA ADUSE OPOKU ,10xxxxxx87,GIPS Transfer", ["Hans Opoku"])).toBe(true);
    expect(isOwnName("ANNETTE AKUSHIKA KWASHIE", ["Hans Opoku"])).toBe(false);
    expect(payeeKey("  Rukaya   ISSIFU. ")).toBe("rukaya issifu");
  });
});
