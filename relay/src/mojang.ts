import { SESSION_SERVER, log } from "./config.ts";

export type Profile = { id: string; name: string };

export async function hasJoined(name: string, serverId: string): Promise<Profile | null> {
  const query = new URLSearchParams({ username: name, serverId });
  try {
    const res = await fetch(`${SESSION_SERVER}/session/minecraft/hasJoined?${query}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as Partial<Profile>;
    return body.id && body.name ? { id: body.id, name: body.name } : null;
  } catch (e) {
    log("hasJoined failed:", (e as Error).message);
    return null;
  }
}

export function normUuid(u: unknown): string {
  return String(u ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
}
