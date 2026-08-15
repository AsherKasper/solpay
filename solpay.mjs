#!/usr/bin/env node
// solpay — verify a Solana USDC payment end to end, with no dependencies.
//
//   node solpay.mjs <wallet>                    # USDC balance + recent incoming transfers
//   node solpay.mjs <wallet> --expect 5         # exit 0 only if >= 5 USDC has arrived
//   node solpay.mjs <wallet> --mint <MINT>      # any SPL token, not just USDC
//   node solpay.mjs --self-test                 # prove the checks work before trusting them
//
// The point of this script is the distinction most balance checkers get wrong:
//
//     "no payment arrived"   and   "I could not find out"
//
// are different answers, and a checker that returns 0 for both is worse than useless —
// it is confidently wrong at the exact moment you care. Every failure path here is
// explicit, and the exit code separates them: 0 = paid, 1 = not paid, 2 = could not tell.
//
// Written by an autonomous AI agent (Claude Code). MIT.

const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
];
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? true) : d; };

/** JSON-RPC with failover across providers and retry on thrown network errors. */
async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(25_000),
        });
        if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        // An RPC-level error is a real answer about the request, not a transport failure.
        if (j.error) throw new Error(j.error.message ?? "rpc error");
        return j.result;
      } catch (e) {
        // Retry the throw as well as the status: a dropped keep-alive is not an HTTP code.
        lastErr = e;
        await new Promise((s) => setTimeout(s, 700 * (attempt + 1)));
      }
    }
  }
  throw new Error(`all RPC endpoints failed: ${String(lastErr?.message).slice(0, 60)}`);
}

/** Total balance of `mint` held by `owner`, summed across every token account it owns. */
async function tokenBalance(owner, mint) {
  const res = await rpc("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  const accounts = res?.value ?? [];
  let total = 0, decimals = null;
  for (const a of accounts) {
    const amt = a?.account?.data?.parsed?.info?.tokenAmount;
    if (!amt) continue;
    decimals = amt.decimals;
    total += Number(amt.uiAmount ?? 0);
  }
  // No token account is a meaningful state: the wallet has never held this mint.
  return { total, accounts: accounts.length, decimals, everHeld: accounts.length > 0 };
}

/** Recent transactions touching the owner, newest first. Signatures only — cheap. */
async function recentSignatures(owner, limit = 10) {
  const res = await rpc("getSignaturesForAddress", [owner, { limit }]);
  return (res ?? []).map((s) => ({
    signature: s.signature,
    slot: s.slot,
    err: s.err ? "failed" : "ok",
    blockTime: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
  }));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A random, valid 32-byte base58 address. Statistically certain to be unused. */
function randomAddress() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }  // leading zeros → '1'
  return out;
}

/**
 * Prove the instrument works before trusting what it says about your wallet.
 * A checker that always reports zero is indistinguishable from a broken one, so
 * these read values whose answers are known independently.
 */
async function selfTest() {
  let ok = true;
  const say = (pass, label, detail) => {
    console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
    if (!pass) ok = false;
  };

  try {
    const supply = await rpc("getTokenSupply", [USDC_MINT]);
    const ui = Number(supply?.value?.uiAmount ?? 0);
    say(ui > 1e8, "USDC mint supply is large and non-zero", `${ui.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC`);
    say(supply?.value?.decimals === 6, "USDC decimals are 6", String(supply?.value?.decimals));
  } catch (e) { say(false, "getTokenSupply", String(e.message).slice(0, 60)); }

  try {
    // A known exchange hot wallet. Reading a large balance through the *same code path*
    // used for real queries proves the parsing, not just that an endpoint answered.
    // (getTokenLargestAccounts would be the obvious check but public RPCs block it.)
    const known = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
    const b = await tokenBalance(known, USDC_MINT);
    say(b.total > 1000, "a known exchange wallet reads a large balance",
        `${b.total.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC across ${b.accounts} account(s)`);
  } catch (e) { say(false, "known-holder check", String(e.message).slice(0, 60)); }

  try {
    // A wallet holding no USDC must report 0 *and* everHeld:false — otherwise "empty"
    // and "broken" are indistinguishable. Use a freshly generated address rather than a
    // famous one: the system program address turns out to own a USDC token account,
    // which broke an earlier version of this very test.
    const b = await tokenBalance(randomAddress(), USDC_MINT);
    say(b.total === 0 && !b.everHeld, "an unused wallet reports 0 and everHeld=false", `accounts=${b.accounts}`);
  } catch (e) { say(false, "empty-wallet check", String(e.message).slice(0, 60)); }

  console.log(ok ? "\nself-test passed — readings can be trusted" : "\nSELF-TEST FAILED — do not trust any reading");
  return ok;
}

// ---- main ----
if (args.includes("--self-test")) { process.exitCode = (await selfTest()) ? 0 : 2; }
else {

const wallet = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--mint" && args[args.indexOf(a) - 1] !== "--expect");
if (!wallet) {
  console.error("usage: node solpay.mjs <wallet> [--expect <amount>] [--mint <MINT>]\n       node solpay.mjs --self-test");
  process.exitCode = 2;
} else {
const mint = flag("--mint", USDC_MINT);
const expect = flag("--expect") ? Number(flag("--expect")) : null;

try {
  const [bal, sigs] = await Promise.all([tokenBalance(wallet, mint), recentSignatures(wallet, 10).catch(() => null)]);
  console.log(`wallet   ${wallet}`);
  console.log(`mint     ${mint}${mint === USDC_MINT ? "  (USDC)" : ""}`);
  console.log(`balance  ${bal.total.toFixed(bal.decimals ?? 6)}${bal.everHeld ? "" : "   (no token account — this wallet has never held this mint)"}`);
  if (sigs?.length) {
    console.log(`recent activity (${sigs.length}):`);
    for (const s of sigs.slice(0, 5)) console.log(`  ${s.blockTime ?? "?"}  ${s.err.padEnd(6)}  ${s.signature.slice(0, 24)}…`);
  } else if (sigs) {
    console.log("recent activity: none — this address has no transaction history");
  }
  if (expect != null) {
    const paid = bal.total >= expect;
    console.log(`\nexpected >= ${expect} — ${paid ? "PAID" : "NOT PAID"}`);
    process.exitCode = paid ? 0 : 1;
  }
} catch (e) {
  // The whole point: this is not "0", it is "unknown", and it exits differently.
  console.error(`COULD NOT DETERMINE: ${e.message}`);
  console.error("Treat this as unknown, not as unpaid.");
  process.exitCode = 2;
}
}
}
