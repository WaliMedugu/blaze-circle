import { describe, expect, it } from "vitest";
import { MockBank } from "./mock";

const DAY = new Date(Date.now() + 86_400_000);

function setup(limit = 5000) {
  const bank = new MockBank();
  const deviceId = bank.registerDevice("u_wali", "pk");
  return { bank, deviceId, issue: (certId: string, l = limit) => bank.placePocketLien({ userId: "u_wali", deviceId, certId, limit: l, expiresAt: DAY }) };
}
const v = (ctr: number, amount: number, nonce: string, submittedBy: "merchant" | "payer" = "merchant") => ({
  certId: "c1", ctr, merchantId: "m_mama_tee", amount, nonce, payload: "qr", submittedBy,
});

describe("MockBank pocket + settlement", () => {
  it("liens the pocket, then settles from it to the merchant", async () => {
    const { bank, issue } = setup();
    await issue("c1");
    expect((await bank.getAccount("u_wali")).lien).toBe(5000);
    expect(await bank.settleVoucher(v(1, 500, "n1"))).toBe("SETTLED_CONFIRMED");
    expect(await bank.getAccount("u_wali")).toMatchObject({ balance: 17_750, lien: 4500 });
    expect((await bank.getAccount("m_mama_tee")).balance).toBe(500);
  });

  it("is idempotent when merchant and payer both upload", async () => {
    const { bank, issue } = setup();
    await issue("c1");
    expect(await bank.settleVoucher(v(1, 500, "n1", "payer"))).toBe("PENDING");
    await bank.settleVoucher(v(1, 500, "n1"));
    expect(await bank.settleVoucher(v(1, 500, "n1"))).toBe("SETTLED_CONFIRMED");
    expect(await bank.settleVoucher(v(1, 500, "n1", "payer"))).toBe("SETTLED_CONFIRMED");
    expect((await bank.getAccount("m_mama_tee")).balance).toBe(500);
  });

  it("refuses a pocket bigger than available balance", async () => {
    const { bank, deviceId } = setup();
    await expect(bank.placePocketLien({ userId: "u_timothy", deviceId, certId: "x", limit: 100, expiresAt: DAY })).rejects.toThrow("unknown_device");
    const d2 = bank.registerDevice("u_timothy", "pk");
    await bank.placePocketLien({ userId: "u_timothy", deviceId: d2, certId: "t1", limit: 5000, expiresAt: DAY });
    await expect(bank.placePocketLien({ userId: "u_timothy", deviceId: d2, certId: "t2", limit: 5000, expiresAt: DAY })).resolves.toBeUndefined();
  });

  it("double-spent counter: merchant still paid, payer charged, device revoked", async () => {
    const { bank, issue, deviceId } = setup();
    await issue("c1");
    await bank.settleVoucher(v(1, 3000, "n1"));
    await bank.settleVoucher(v(1, 3000, "n2")); // cloned device reused ctr 1
    expect((await bank.getAccount("m_mama_tee")).balance).toBe(6000);
    expect(await bank.getAccount("u_wali")).toMatchObject({ balance: 12_250, lien: 0 });
    expect(bank.devices.get(deviceId)?.revoked).toBe(true);
    expect(bank.payments[0].fraud).toBe("double_spend");
  });

  it("renewing keeps lien only for reported-but-unsettled spend", async () => {
    const { bank, issue } = setup();
    await issue("c1");
    await bank.settleVoucher(v(1, 1000, "n1", "payer")); // merchant offline for now
    await issue("c2", 2000);
    expect((await bank.getAccount("u_wali")).lien).toBe(1000 + 2000);
    await bank.settleVoucher(v(1, 1000, "n1")); // merchant finally syncs against old cert
    expect(await bank.getAccount("u_wali")).toMatchObject({ balance: 17_250, lien: 2000 });
  });

  it("online pay debits available balance once per request", () => {
    const { bank } = setup();
    expect(bank.payOnline("u_wali", "m_mama_tee", 3500, "r1")).toBe("SETTLED_CONFIRMED");
    expect(bank.payOnline("u_wali", "m_mama_tee", 3500, "r1")).toBe("REJECTED");
    expect(bank.payOnline("u_wali", "m_mama_tee", 999_999, "r2")).toBe("insufficient_funds");
    expect(bank.requestStatus("r1")).toEqual({ paid: true, payerTag: "$wali" });
  });
});
