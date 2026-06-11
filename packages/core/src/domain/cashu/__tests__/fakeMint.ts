/**
 * Deterministic in-process fake Cashu mint for engine tests (test-only,
 * excluded from the build). Implements the NUT endpoints cashu-ts 2.9.0
 * hits — info, keys/keysets, swap, mint/melt quotes, mint, melt (NUT-08
 * change), checkstate, restore — with REAL BDHKE signing via cashu-ts's own
 * mint-side crypto, so wallet flows complete end-to-end and produce real,
 * deterministic proofs. No network: it is exposed to the engine as an
 * HttpClient Layer, exercising the exact transport-injection path used in
 * production.
 *
 * Key material matches the golden fixtures: per-amount private keys are
 * sha256(utf8("linky/fake-mint/sat/<amount>")), amounts 1..1024; the keyset
 * id derives via cashu-ts `deriveKeysetId` (pinned by the fixtures).
 */
import type { SerializedBlindedMessage, SerializedBlindedSignature } from "@cashu/cashu-ts";
import { deriveKeysetId } from "@cashu/cashu-ts";
import { hashToCurve, pointFromHex } from "@cashu/cashu-ts/crypto/common";
import { createBlindSignature, getPubKeyFromPrivKey } from "@cashu/cashu-ts/crypto/mint";
import { bytesToNumber } from "@cashu/cashu-ts/crypto/util";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect, Layer } from "effect";

import { HttpClient, HttpClientResponse } from "../../../ports/index.js";

const AMOUNTS = Array.from({ length: 11 }, (_, i) => 2 ** i); // 1..1024

interface ProofLike {
  readonly id: string;
  readonly amount: number;
  readonly secret: string;
  readonly C: string;
}

interface MintQuoteRecord {
  amount: number;
  unit: string;
  state: "UNPAID" | "PAID" | "ISSUED";
  expiry: number;
  request: string;
}

interface MeltQuoteRecord {
  amount: number;
  fee_reserve: number;
  unit: string;
  state: "UNPAID" | "PENDING" | "PAID";
  expiry: number;
  request: string;
  payment_preimage: string | null;
}

interface FakeMintOptions {
  /** input_fee_ppk advertised on the keyset (default 0). */
  readonly inputFeePpk?: number;
  /** Serve a bogus keyset id so cashu-ts keyset verification fails. */
  readonly breakKeysetId?: boolean;
  /** Quote expiry timestamp (unix seconds) for new quotes. */
  readonly quoteExpiry?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export interface FakeMintResponse {
  readonly status: number;
  readonly body: unknown;
}

const protocolError = (code: number, detail: string): FakeMintResponse => ({
  status: 400,
  body: { code, detail },
});

export class FakeMint {
  readonly privKeys = new Map<number, Uint8Array>();
  readonly pubKeys: Record<string, string> = {};
  readonly keysetId: string;
  readonly servedKeysetId: string;

  /** B_ -> signature the mint has issued (NUT-09 restore source of truth). */
  readonly promises = new Map<string, SerializedBlindedSignature>();
  /** B_ values that behave like orphan unsigned promises (NUT 11004). */
  readonly pendingBs = new Set<string>();
  /** Y -> SPENT/PENDING (absent = UNSPENT). */
  readonly proofStates = new Map<string, "SPENT" | "PENDING">();
  readonly mintQuotes = new Map<string, MintQuoteRecord>();
  readonly meltQuotes = new Map<string, MeltQuoteRecord>();
  /** Request paths seen (no bodies — useful for cheap assertions). */
  readonly requestPaths: string[] = [];

  /** LN fee the next melts actually charge (capped by fee_reserve). */
  feePaidPerMelt = 0;

  private quoteCounter = 0;
  private readonly inputFeePpk: number;
  private readonly quoteExpiry: number;

  constructor(options?: FakeMintOptions) {
    this.inputFeePpk = options?.inputFeePpk ?? 0;
    this.quoteExpiry = options?.quoteExpiry ?? 4_000_000_000; // far future
    for (const amount of AMOUNTS) {
      const priv = sha256(utf8ToBytes(`linky/fake-mint/sat/${amount}`));
      this.privKeys.set(amount, priv);
      this.pubKeys[String(amount)] = bytesToHex(getPubKeyFromPrivKey(priv));
    }
    this.keysetId = deriveKeysetId(this.pubKeys);
    this.servedKeysetId = options?.breakKeysetId === true ? "00deadbeefdead00" : this.keysetId;
  }

  yOfSecret(secret: string): string {
    return hashToCurve(utf8ToBytes(secret)).toHex(true);
  }

  markSpent(secret: string): void {
    this.proofStates.set(this.yOfSecret(secret), "SPENT");
  }

  markPending(secret: string): void {
    this.proofStates.set(this.yOfSecret(secret), "PENDING");
  }

  /** Pre-signs an output, as if a prior session had it signed (11005 setup). */
  signOutput(output: SerializedBlindedMessage, keysetId?: string): SerializedBlindedSignature {
    const amount = Number(output.amount) || 0;
    const priv = this.privKeys.get(amount);
    if (priv === undefined) throw new Error(`fake mint: no key for amount ${String(amount)}`);
    const id = keysetId ?? this.servedKeysetId;
    const signature = createBlindSignature(pointFromHex(output.B_), priv, amount, id);
    const serialized: SerializedBlindedSignature = {
      id,
      amount,
      C_: signature.C_.toHex(true),
    };
    this.promises.set(output.B_, serialized);
    return serialized;
  }

  payQuote(quoteId: string): void {
    const quote = this.mintQuotes.get(quoteId);
    if (quote === undefined) throw new Error("fake mint: unknown quote");
    if (quote.state === "UNPAID") quote.state = "PAID";
  }

  expireQuote(quoteId: string): void {
    const quote = this.mintQuotes.get(quoteId);
    if (quote === undefined) throw new Error("fake mint: unknown quote");
    quote.expiry = 1; // long past
  }

  /** Creates an already-PAID quote without going through the engine. */
  seedPaidQuote(amount: number): string {
    this.quoteCounter += 1;
    const quoteId = `quote-${String(this.quoteCounter)}`;
    this.mintQuotes.set(quoteId, {
      amount,
      unit: "sat",
      state: "PAID",
      expiry: this.quoteExpiry,
      request: `lnfake${String(amount)}`,
      });
    return quoteId;
  }

  private verifyInput(proof: ProofLike): FakeMintResponse | null {
    const priv = this.privKeys.get(Number(proof.amount) || 0);
    if (priv === undefined) return protocolError(10003, "unknown amount");
    const expected = hashToCurve(utf8ToBytes(proof.secret))
      .multiply(bytesToNumber(priv))
      .toHex(true);
    if (expected !== String(proof.C).toLowerCase()) {
      return protocolError(10003, "could not verify proof");
    }
    const state = this.proofStates.get(this.yOfSecret(proof.secret));
    if (state === "SPENT") return protocolError(11001, "Token is already spent.");
    if (state === "PENDING") return protocolError(11002, "Token is pending.");
    return null;
  }

  private checkOutputCollisions(outputs: ReadonlyArray<SerializedBlindedMessage>):
    | FakeMintResponse
    | null {
    for (const output of outputs) {
      if (this.pendingBs.has(output.B_)) {
        return protocolError(11004, "outputs are pending.");
      }
    }
    for (const output of outputs) {
      if (this.promises.has(output.B_)) {
        return protocolError(11005, "outputs have already been signed before.");
      }
    }
    return null;
  }

  private signOutputs(outputs: ReadonlyArray<SerializedBlindedMessage>): FakeMintResponse | {
    signatures: SerializedBlindedSignature[];
  } {
    const collision = this.checkOutputCollisions(outputs);
    if (collision !== null) return collision;
    return { signatures: outputs.map((output) => this.signOutput(output)) };
  }

  handle(method: string, path: string, body: unknown): FakeMintResponse {
    this.requestPaths.push(`${method} ${path}`);

    if (method === "GET" && path === "/v1/info") {
      return {
        status: 200,
        body: {
          name: "Linky Fake Mint",
          pubkey: this.pubKeys["1"],
          version: "FakeMint/0.1.0",
          description: "deterministic in-process test mint",
          nuts: {
            "4": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
            "5": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
            "7": { supported: true },
            "8": { supported: true },
            "9": { supported: true },
          },
        },
      };
    }

    if (method === "GET" && path === "/v1/keysets") {
      return {
        status: 200,
        body: {
          keysets: [
            {
              id: this.servedKeysetId,
              unit: "sat",
              active: true,
              input_fee_ppk: this.inputFeePpk,
            },
          ],
        },
      };
    }

    if (method === "GET" && (path === "/v1/keys" || path.startsWith("/v1/keys/"))) {
      const requestedId = path === "/v1/keys" ? this.servedKeysetId : path.slice("/v1/keys/".length);
      if (requestedId !== this.servedKeysetId) {
        return protocolError(12001, "keyset not found");
      }
      return {
        status: 200,
        body: { keysets: [{ id: this.servedKeysetId, unit: "sat", keys: this.pubKeys }] },
      };
    }

    if (method === "POST" && path === "/v1/swap" && isRecord(body)) {
      const inputs = (body["inputs"] ?? []) as ProofLike[];
      const outputs = (body["outputs"] ?? []) as SerializedBlindedMessage[];
      for (const input of inputs) {
        const invalid = this.verifyInput(input);
        if (invalid !== null) return invalid;
      }
      const signed = this.signOutputs(outputs);
      if ("status" in signed) return signed;
      for (const input of inputs) this.markSpent(input.secret);
      return { status: 200, body: signed };
    }

    if (method === "POST" && path === "/v1/mint/quote/bolt11" && isRecord(body)) {
      this.quoteCounter += 1;
      const quoteId = `quote-${String(this.quoteCounter)}`;
      const amount = Number(body["amount"]) || 0;
      const record: MintQuoteRecord = {
        amount,
        unit: String(body["unit"] ?? "sat"),
        state: "UNPAID",
        expiry: this.quoteExpiry,
        request: `lnfake${String(amount)}q${String(this.quoteCounter)}`,
      };
      this.mintQuotes.set(quoteId, record);
      return {
        status: 200,
        body: { quote: quoteId, request: record.request, state: record.state, expiry: record.expiry },
      };
    }

    if (method === "GET" && path.startsWith("/v1/mint/quote/bolt11/")) {
      const quoteId = path.slice("/v1/mint/quote/bolt11/".length);
      const record = this.mintQuotes.get(quoteId);
      if (record === undefined) return protocolError(20005, "quote not found");
      return {
        status: 200,
        body: {
          quote: quoteId,
          request: record.request,
          state: record.state,
          expiry: record.expiry,
          amount: record.amount,
          unit: record.unit,
        },
      };
    }

    if (method === "POST" && path === "/v1/mint/bolt11" && isRecord(body)) {
      const quoteId = String(body["quote"] ?? "");
      const outputs = (body["outputs"] ?? []) as SerializedBlindedMessage[];
      const record = this.mintQuotes.get(quoteId);
      if (record === undefined) return protocolError(20005, "quote not found");
      // Output collisions surface before quote-state checks: a prior session
      // may have signed these exact outputs (deterministic recovery path).
      const collision = this.checkOutputCollisions(outputs);
      if (collision !== null) return collision;
      if (record.state === "UNPAID") return protocolError(20001, "quote not paid");
      if (record.state === "ISSUED") {
        return protocolError(20002, "issued quote must not be minted again");
      }
      const requested = outputs.reduce((sum, output) => sum + (Number(output.amount) || 0), 0);
      if (requested !== record.amount) {
        return protocolError(11000, "amount mismatch");
      }
      const signed = this.signOutputs(outputs);
      if ("status" in signed) return signed;
      record.state = "ISSUED";
      return { status: 200, body: signed };
    }

    if (method === "POST" && path === "/v1/melt/quote/bolt11" && isRecord(body)) {
      // Fake invoice format: "fakeinvoice:<amount>:<feeReserve>".
      const request = String(body["request"] ?? "");
      const match = /^fakeinvoice:(\d+):(\d+)$/.exec(request);
      if (match === null) return protocolError(20006, "invalid invoice");
      this.quoteCounter += 1;
      const quoteId = `melt-${String(this.quoteCounter)}`;
      const record: MeltQuoteRecord = {
        amount: Number(match[1]),
        fee_reserve: Number(match[2]),
        unit: String(body["unit"] ?? "sat"),
        state: "UNPAID",
        expiry: this.quoteExpiry,
        request,
        payment_preimage: null,
      };
      this.meltQuotes.set(quoteId, record);
      return {
        status: 200,
        body: {
          quote: quoteId,
          amount: record.amount,
          fee_reserve: record.fee_reserve,
          state: record.state,
          expiry: record.expiry,
          request,
          unit: record.unit,
          payment_preimage: null,
        },
      };
    }

    if (method === "POST" && path === "/v1/melt/bolt11" && isRecord(body)) {
      const quoteId = String(body["quote"] ?? "");
      const inputs = (body["inputs"] ?? []) as ProofLike[];
      const outputs = (body["outputs"] ?? []) as SerializedBlindedMessage[];
      const record = this.meltQuotes.get(quoteId);
      if (record === undefined) return protocolError(20005, "quote not found");
      for (const input of inputs) {
        const invalid = this.verifyInput(input);
        if (invalid !== null) return invalid;
      }
      const collision = this.checkOutputCollisions(outputs);
      if (collision !== null) return collision;

      const inputTotal = inputs.reduce((sum, input) => sum + (Number(input.amount) || 0), 0);
      if (inputTotal < record.amount + record.fee_reserve) {
        return protocolError(11006, "amount too low");
      }
      for (const input of inputs) this.markSpent(input.secret);

      const feePaid = Math.min(Math.max(0, this.feePaidPerMelt), record.fee_reserve);
      let overpaid = inputTotal - record.amount - feePaid;
      // NUT-08: assign the returned amount to blank outputs in binary
      // decomposition order; unsigned blanks stay unsigned promises.
      const change: SerializedBlindedSignature[] = [];
      for (const output of outputs) {
        if (overpaid <= 0) break;
        const amount = 2 ** Math.floor(Math.log2(overpaid));
        change.push(this.signOutput({ ...output, amount }));
        overpaid -= amount;
      }
      record.state = "PAID";
      record.payment_preimage = "fake-preimage";
      return {
        status: 200,
        body: {
          quote: quoteId,
          amount: record.amount,
          fee_reserve: record.fee_reserve,
          state: record.state,
          expiry: record.expiry,
          request: record.request,
          unit: record.unit,
          payment_preimage: record.payment_preimage,
          fee_paid: feePaid,
          change,
        },
      };
    }

    if (method === "POST" && path === "/v1/checkstate" && isRecord(body)) {
      const ys = (body["Ys"] ?? []) as string[];
      return {
        status: 200,
        body: {
          states: ys.map((y) => ({
            Y: y,
            state: this.proofStates.get(y) ?? "UNSPENT",
            witness: null,
          })),
        },
      };
    }

    if (method === "POST" && path === "/v1/restore" && isRecord(body)) {
      const outputs = (body["outputs"] ?? []) as SerializedBlindedMessage[];
      const matchedOutputs: SerializedBlindedMessage[] = [];
      const signatures: SerializedBlindedSignature[] = [];
      for (const output of outputs) {
        const promise = this.promises.get(output.B_);
        if (promise === undefined) continue;
        matchedOutputs.push(output);
        signatures.push(promise);
      }
      return { status: 200, body: { outputs: matchedOutputs, signatures } };
    }

    return { status: 404, body: { error: `fake mint: no route ${method} ${path}` } };
  }
}

// ---------------------------------------------------------------------------
// HttpClient Layer over one or more fake mints
// ---------------------------------------------------------------------------

const bodyJsonOf = (request: { readonly body: unknown }): unknown => {
  const body = request.body as { _tag?: string; body?: unknown };
  if (body?._tag === "Uint8Array" && body.body instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(body.body));
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * HttpClient Layer routing requests for each base URL to its fake mint.
 * Unknown URLs get a 404 — tests never touch the network.
 */
export const fakeMintHttpLayer = (
  mints: ReadonlyArray<readonly [baseUrl: string, mint: FakeMint]>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        for (const [baseUrl, mint] of mints) {
          const base = baseUrl.replace(/\/+$/, "");
          if (request.url === base || request.url.startsWith(`${base}/`)) {
            const path = request.url.slice(base.length) || "/";
            const result = mint.handle(request.method, path, bodyJsonOf(request));
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(result.body), {
                status: result.status,
                headers: { "content-type": "application/json" },
              }),
            );
          }
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ error: "unknown host" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

export const FAKE_MINT_URL = "https://fakemint.test";
