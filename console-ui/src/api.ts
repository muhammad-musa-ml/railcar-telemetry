import type { ErrorResponse } from "../../src/console/api-types";

// Calls to the console's own API. The page talks to nothing else.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorResponse | null,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" }, signal });
  const body = await readBody(res);
  if (!res.ok) {
    const error = body as ErrorResponse | null;
    throw new ApiError(res.status, error, error?.error ?? `${path} answered ${res.status}`);
  }
  return body as T;
}

export interface ActionResult {
  status: number;
  body: Record<string, unknown> & Partial<ErrorResponse>;
}

// Actions answer with a status the caller has to tell apart (401, 404, 409,
// 422, 429, 503), so this returns the answer instead of throwing.
export async function postAction(path: string, token: string, body: object): Promise<ActionResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: ((await readBody(res)) ?? {}) as ActionResult["body"] };
}

// What to tell the operator about an action that did not succeed.
export function describeFailure(result: ActionResult): string {
  const text = result.body.error ?? `answered ${result.status}`;
  switch (result.status) {
    case 401:
      return "The operator token was not accepted.";
    case 429:
      return `Too many actions: ${text}`;
    default:
      return text;
  }
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
