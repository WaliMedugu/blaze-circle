export const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
export const nowS = () => Math.floor(Date.now() / 1000);

/** Plain-language messages for every RejectReason, shown to students and vendors. */
export const REASON_TEXT: Record<string, string> = {
  malformed: "That code isn't a Blaze payment.",
  bad_cert_sig: "This pocket wasn't issued by Ecobank. Don't accept.",
  cert_expired: "Pocket expired. Get signal and top up to renew.",
  bad_sig: "Payment code was tampered with. Don't accept.",
  wrong_merchant: "This code was made for a different vendor.",
  nonce_mismatch: "This code belongs to a different sale. Ask them to scan again.",
  amount_mismatch: "Amount doesn't match this sale.",
  expired: "Code expired (over 90 s). Ask the customer to scan again.",
  replay: "This code was already used.",
  over_limit: "Not enough left in your Blaze Pocket.",
  counter_exceeded: "3 offline payments used. Get signal to sync and keep paying.",
  insufficient_funds: "Not enough money in the account.",
  unknown_cert: "Bank doesn't recognise this pocket.",
  offline: "No connection.",
};
export const reasonText = (r?: string) => (r && REASON_TEXT[r]) || "Something went wrong.";
