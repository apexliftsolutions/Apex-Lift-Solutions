// Normalizes a HelcimPay.js SUCCESS payload into a small, safe shape.
//
// Helcim documents eventMessage as "a JSON.stringify version of the transaction
// response", and their own examples show more than one nesting:
//
//   A  "{\"status\":200,\"data\":{\"data\":{...txn},\"hash\":\"...\"}}"   (string)
//   B  { status:200, data:{ data:{...txn}, hash:"..." } }                (object)
//   C  { hash:"...", data:{...txn} }                                     (normalized)
//
// Coding against one guessed level is what broke the $1.19 payment: the frontend
// read eventMessage?.data on a STRING, got undefined, and sent "{}".
//
// This returns ONLY non-sensitive fields. Card and bank identifiers are
// deliberately not carried out of here.

export interface HelcimPayNormalized {
  transactionId: string | null;
  hash: string | null;
  amount: string | null;
  currency: string | null;
  status: string | null;
  type: string | null;
  dateCreated: string | null;
  /** Candidate serializations the hash may have been computed over. */
  hashCandidates: string[];
  /** Structural facts, safe to log. */
  shape: {
    inputType: string;
    parsedOk: boolean;
    depth: number;
    wrapper: string;
    transactionIdFound: boolean;
    hashFound: boolean;
  };
}

function deepParse(v: unknown, max = 3): { value: unknown; depth: number; ok: boolean } {
  let cur = v, depth = 0, ok = true;
  while (typeof cur === "string" && depth < max) {
    const t = cur.trim();
    if (!t) break;
    // Do NOT require a leading brace: a double-encoded payload starts with a
    // quote. Let JSON.parse decide, and stop cleanly if it is not JSON.
    try {
      const next = JSON.parse(t);
      cur = next; depth++;
      if (typeof next !== "string" && typeof next !== "object") break;
    } catch { ok = false; break; }
  }
  return { value: cur, depth, ok };
}

const looksLikeTxn = (o: unknown): o is Record<string, unknown> =>
!!o && typeof o === "object" &&
("transactionId" in (o as object) || "cardTransactionId" in (o as object) ||
"bankTransactionId" in (o as object));

function pickId(o: Record<string, unknown> | null): string | null {
  if (!o) return null;
  for (const k of ["transactionId", "cardTransactionId", "bankTransactionId", "id"]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
  }
  return null;
}

export function normalizeHelcimPayResponse(input: unknown): HelcimPayNormalized {
  const inputType = typeof input;
  const { value, depth, ok } = deepParse(input);
  const root = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;

  const dataNode = (root.data && typeof root.data === "object")
  ? root.data as Record<string, unknown> : null;
  const innerNode = (dataNode?.data && typeof dataNode.data === "object")
  ? dataNode.data as Record<string, unknown> : null;

  // Hash sits beside the object it covers.
  const hash = (typeof root.hash === "string" && root.hash) ? root.hash
  : (dataNode && typeof dataNode.hash === "string" && dataNode.hash) ? dataNode.hash
  : null;

  // Find the transaction object among the documented positions.
  let txn: Record<string, unknown> | null = null;
  let wrapper = "unknown";
  if (looksLikeTxn(innerNode))      { txn = innerNode; wrapper = "data.data"; }
  else if (looksLikeTxn(dataNode))  { txn = dataNode;  wrapper = "data"; }
  else if (looksLikeTxn(root))      { txn = root;      wrapper = "root"; }
  else if (innerNode)               { txn = innerNode; wrapper = "data.data(no-id)"; }
  else if (dataNode)                { txn = dataNode;  wrapper = "data(no-id)"; }

  // The hash covers the node adjacent to it. Offer every plausible
  // serialization so the server can match whichever Helcim actually used.
  const candidates: string[] = [];
  const push = (o: unknown) => {
    if (o && typeof o === "object") {
      try { const s = JSON.stringify(o); if (s && !candidates.includes(s)) candidates.push(s); } catch { /* skip */ }
    }
  };
  push(innerNode); push(dataNode); push(txn); push(root);
  if (typeof input === "string") candidates.push(input);

  const transactionId = pickId(txn);
  const s = (k: string) => {
    const v = txn?.[k];
    return v === undefined || v === null ? null : String(v);
  };

  return {
    transactionId,
    hash,
    amount: s("amount"),
    currency: s("currency"),
    status: s("status"),
    type: s("type"),
    dateCreated: s("dateCreated"),
    hashCandidates: candidates,
    shape: {
      inputType, parsedOk: ok, depth, wrapper,
      transactionIdFound: !!transactionId, hashFound: !!hash,
    },
  };
}
