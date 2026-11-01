import { describe, expect, it } from "vitest";

import { accountOf, cardMerchant, isOwnName, parseBankText, payeeKey, sourceName } from "@/lib/bank/parse";

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

  it("reads a cross-network push with its fee, new balance and in-message time", () => {
    const text =
      "Your payment of GHS 30.50 to TELECEL PUSH has been completed at 2026-10-24 20:23:55. Your new balance: GHS 343.94. Fee was GHS 0.38 Tax was GHS -. Reference: -. Financial Transaction Id: 92282961231. External Transaction Id: 92282961231.";
    expect(parseBankText(text, options)[0]).toMatchObject({
      direction: "out",
      amount: "30.50",
      fee: "0.38",
      counterparty: "TELECEL PUSH",
      balance: "343.94",
      externalId: "92282961231",
      occurredAt: "2026-10-24T20:23:00.000Z",
    });
  });

  it("dates messages from Yesterday and weekday headings", () => {
    const text = [
      "Yesterday 11:36 AM",
      "Payment made for GHS 31.50 to AMOS SEKYI SAM Current Balance: GHS 374.82 . Available Balance: GHS 374.82. Reference: . Transaction ID: 92243526792. Fee charged: GHS0.00",
      "Yesterday 7:54 PM",
      "Secure your future with Insurance on MoMo and get 300MB FREE data when you sign up.",
      "Thursday 9:05 AM",
      "Payment made for GHS 12.00 to ABENA KYEI Current Balance: GHS 362.82 . Transaction ID: 92243526000. Fee charged: GHS0.00",
    ].join("\n");
    expect(parseBankText(text, options).map((item) => [item.counterparty, item.occurredAt])).toEqual([
      ["AMOS SEKYI SAM", "2026-10-24T11:36:00.000Z"],
      ["ABENA KYEI", "2026-10-22T09:05:00.000Z"],
    ]);
  });

  describe("Absa", () => {
    // Real Absa Ghana wordings, with the names and numbers changed.
    const HOLD =
      "Transaction of GHS 33.00 earmarked on your account ending 4821 as of 11 Oct 2026 17:37 at Spotify_P47E4EAB37_STOCKHOLM_SE. Available balance is GHS 2048.22.";
    const FOREIGN_HOLD =
      "Transaction of USD 5.99 equivalent to GHS 75.56 earmarked on your account ending 4821 as of 07 Oct 2026 13:37 at APPLE.COM/BILL_ITUNES.COM_IE. Available balance is GHS 3321.31.";
    const DEBIT =
      "GHS 100.00 has been debited to your account ending 4821 as of 11 Oct 2026 18:33. Your available balance is 1,947.22 Credit transactions may not yet have cleared";
    const FEE =
      "GHS 1.00 has been debited to your account ending 4821 as of 11 Oct 2026 18:33. Your available balance is 1,946.22 Credit transactions may not yet have cleared";
    const TRANSFER =
      "Dear Customer, Transfer of GHS100 from your account ending 4821 to 233241234567 KOFI MENSAH ADDO on 11/10/26 18:33 was successful. WALLET TxnID 17917435599999";
    const DECLINED = "Dear Customer, your last Credit Card transaction has been declined due to insufficient funds. Your available balance is 0.00";

    it("reads a card hold as money out at the merchant, dated from the text", () => {
      expect(parseBankText(HOLD, options)[0]).toMatchObject({
        source: "absa",
        direction: "out",
        amount: "33.00",
        counterparty: "Spotify",
        balance: "2048.22",
        hold: true,
        occurredAt: "2026-10-11T17:37:00.000Z",
        dated: true,
      });
    });

    it("counts the cedi amount of a foreign card payment and keeps the original", () => {
      expect(parseBankText(FOREIGN_HOLD, options)[0]).toMatchObject({ amount: "75.56", counterparty: "APPLE.COM/BILL ITUNES.COM", reference: "USD 5.99", hold: true });
    });

    it("reads a bare debit with its balance", () => {
      expect(parseBankText(DEBIT, options)[0]).toMatchObject({ source: "absa", direction: "out", amount: "100.00", counterparty: "", balance: "1947.22", occurredAt: "2026-10-11T18:33:00.000Z" });
    });

    it("reads a transfer with the recipient's name, number and transaction id", () => {
      expect(parseBankText(TRANSFER, options)[0]).toMatchObject({
        source: "absa",
        direction: "out",
        amount: "100.00",
        counterparty: "KOFI MENSAH ADDO",
        reference: "to 0241234567",
        externalId: "17917435599999",
        occurredAt: "2026-10-11T18:33:00.000Z",
      });
    });

    it("skips declined card payments", () => {
      expect(parseBankText(DECLINED, options)).toHaveLength(0);
    });

    it("splits a run of Absa texts into separate messages", () => {
      const run = [DECLINED, "Sun 11 Oct at 5:37 pm", HOLD, DEBIT, FEE, TRANSFER].join("\n");
      expect(parseBankText(run, options).map((item) => [item.amount, item.counterparty])).toEqual([
        ["33.00", "Spotify"],
        ["100.00", ""],
        ["1.00", ""],
        ["100.00", "KOFI MENSAH ADDO"],
      ]);
    });

    it("reads the account an Absa text is about", () => {
      expect(accountOf(DEBIT)).toBe("4821");
      expect(accountOf(TRANSFER)).toBe("4821");
    });
  });

  it("names merchants and sources the way a person would", () => {
    expect(cardMerchant("NETFLIX.COM_A1B2C3D4E5_LOS GATOS_US")).toBe("NETFLIX.COM");
    expect(sourceName("absa")).toBe("Absa");
    expect(sourceName("momo")).toBe("MoMo");
    expect(sourceName("hubtel")).toBe("Hubtel");
    expect(sourceName("ecobank")).toBe("Ecobank");
    expect(sourceName("stanbic_bank")).toBe("Stanbic Bank");
  });

  it("reads Hubtel wallet deposits and withdrawals", () => {
    const deposit = "GHS 150.00 was deposited into your Hubtel wallet. Available balance: GHS 420.50. Transaction ID: 88123456.";
    const withdrawal = "GHS 45.00 was withdrawn from your Hubtel wallet. Available balance: GHS 375.50. Fee charged: GHS 0.50. Transaction ID: 88123457.";
    expect(parseBankText(deposit, options)[0]).toMatchObject({
      source: "hubtel",
      direction: "in",
      amount: "150.00",
      balance: "420.50",
      externalId: "88123456",
    });
    expect(parseBankText(withdrawal, options)[0]).toMatchObject({
      source: "hubtel",
      direction: "out",
      amount: "45.00",
      fee: "0.50",
      balance: "375.50",
      externalId: "88123457",
    });
  });

  it("does not misread a GHS available balance on a foreign-currency card alert as the movement amount", () => {
    const foreignCard = "Your card was debited with USD 12.00 atGITHUB.COM. Available Balance: GHS 1,840.20.";
    expect(parseBankText(foreignCard, options)).toHaveLength(0);
  });
});
