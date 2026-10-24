import { createHash, timingSafeEqual } from "node:crypto";

// Operator tokens come from the environment as "name:token,name:token". The
// name is what the audit trail records; the token is what an operator sends
// in "Authorization: Bearer <token>".

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
export const MIN_TOKEN_LENGTH = 16;

interface Entry {
  name: string;
  digest: Buffer;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class OperatorTokens {
  private constructor(private readonly entries: Entry[]) {}

  static parse(raw: string): OperatorTokens {
    const pairs = raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (pairs.length === 0) {
      throw new Error("CONSOLE_OPERATOR_TOKENS must name at least one operator as name:token");
    }
    const entries: Entry[] = [];
    const tokens = new Set<string>();
    for (const pair of pairs) {
      const colon = pair.indexOf(":");
      if (colon < 0) {
        throw new Error("each entry of CONSOLE_OPERATOR_TOKENS must look like name:token");
      }
      const name = pair.slice(0, colon);
      const token = pair.slice(colon + 1);
      if (!NAME_PATTERN.test(name)) {
        throw new Error(`operator name "${name}" must be 1-32 letters, digits, dots, dashes or underscores`);
      }
      if (token.length < MIN_TOKEN_LENGTH) {
        throw new Error(`the token for ${name} must be at least ${MIN_TOKEN_LENGTH} characters`);
      }
      if (entries.some((e) => e.name === name)) {
        throw new Error(`operator ${name} is listed twice`);
      }
      if (tokens.has(token)) {
        throw new Error("two operators have the same token");
      }
      tokens.add(token);
      entries.push({ name, digest: digest(token) });
    }
    return new OperatorTokens(entries);
  }

  // The operator a presented token belongs to, or null. Both sides are
  // hashed first so the comparison always runs over 32 bytes, whatever the
  // token's length, and every entry is compared even after a match, so the
  // time taken does not say which entry matched or how much of a guess was
  // right.
  identify(presented: string | undefined): string | null {
    if (presented === undefined || presented === "") return null;
    const candidate = digest(presented);
    let found: string | null = null;
    for (const entry of this.entries) {
      if (timingSafeEqual(candidate, entry.digest) && found === null) {
        found = entry.name;
      }
    }
    return found;
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}
