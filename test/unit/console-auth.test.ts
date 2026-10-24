import { describe, expect, it } from "vitest";
import { bearerToken, OperatorTokens } from "../../src/console/auth";
import { RateLimiter } from "../../src/console/rate-limit";

const ALICE = "alice-token-0123456789";
const BOB = "bob-token-abcdefghijkl";

describe("operator tokens", () => {
  it("names the operator a token belongs to", () => {
    const tokens = OperatorTokens.parse(`alice:${ALICE}, bob:${BOB}`);
    expect(tokens.identify(ALICE)).toBe("alice");
    expect(tokens.identify(BOB)).toBe("bob");
  });

  it("knows nobody for a missing, empty, wrong, truncated or extended token", () => {
    const tokens = OperatorTokens.parse(`alice:${ALICE}`);
    for (const presented of [undefined, "", "wrong", ALICE.slice(0, -1), `${ALICE.slice(0, -1)}X`, `${ALICE}X`, ALICE.toUpperCase()]) {
      expect(tokens.identify(presented), String(presented)).toBeNull();
    }
  });

  it("refuses a configuration it cannot trust", () => {
    expect(() => OperatorTokens.parse("")).toThrow(/at least one/);
    expect(() => OperatorTokens.parse("alice")).toThrow(/name:token/);
    expect(() => OperatorTokens.parse("alice:short")).toThrow(/at least 16 characters/);
    expect(() => OperatorTokens.parse(`alice:${ALICE},alice:${BOB}`)).toThrow(/twice/);
    expect(() => OperatorTokens.parse(`alice:${ALICE},bob:${ALICE}`)).toThrow(/same token/);
    expect(() => OperatorTokens.parse(`Alice Smith:${ALICE}`)).toThrow(/name/);
  });

  it("takes the token from an Authorization: Bearer header only", () => {
    expect(bearerToken(`Bearer ${ALICE}`)).toBe(ALICE);
    expect(bearerToken(`bearer ${ALICE}`)).toBe(ALICE);
    expect(bearerToken(ALICE)).toBeUndefined();
    expect(bearerToken(`Basic ${ALICE}`)).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("rate limiter", () => {
  it("allows a fixed number of attempts per client in a sliding window", () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.take("10.0.0.1")).toEqual({ allowed: true });
    now += 10_000;
    expect(limiter.take("10.0.0.1")).toEqual({ allowed: true });
    now += 10_000;
    // The first attempt leaves the window 40 s from now.
    expect(limiter.take("10.0.0.1")).toEqual({ allowed: false, retryAfterSeconds: 40 });
    // Another client has its own allowance.
    expect(limiter.take("10.0.0.2")).toEqual({ allowed: true });
    now += 40_000;
    expect(limiter.take("10.0.0.1")).toEqual({ allowed: true });
  });

  it("does not count refused attempts against the window", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 60_000, () => now);
    expect(limiter.take("c").allowed).toBe(true);
    for (let i = 0; i < 10; i++) {
      now += 1000;
      expect(limiter.take("c").allowed).toBe(false);
    }
    now = 60_000;
    expect(limiter.take("c").allowed).toBe(true);
  });
});
