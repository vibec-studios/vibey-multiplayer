import { HttpError, call, enabled, healthy, trouble } from "./backend.ts";
import { log } from "./config.ts";
import { normUuid } from "./mojang.ts";

export type AgentIdentity = { uuid: string; name: string; agentId: string; serverId: string | null };
export type TicketResult = { ok: true; identity: AgentIdentity } | { ok: false; code: string; message: string };

const MAX_TICKET = 4096;
const NO_BACKEND = "This relay does not accept Vibe Server Agent tickets.";
const EXPIRED = "The Vibe ticket has expired. Request a new one and connect again.";
const INVALID = "The Vibe ticket is not valid.";
const UNAVAILABLE = "Vibe cannot check the ticket right now. Please try again in a moment.";

export function readTicket(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : "";
}

export async function checkTicket(ticket: string): Promise<TicketResult> {
  if (!enabled) return { ok: false, code: "auth_failed", message: NO_BACKEND };
  if (ticket.length < 10 || ticket.length > MAX_TICKET || !/^[A-Za-z0-9_.-]+$/.test(ticket)) {
    return { ok: false, code: "ticket_invalid", message: INVALID };
  }
  if (expired(ticket)) return { ok: false, code: "ticket_expired", message: EXPIRED };
  let body: any;
  try {
    body = await call("POST", "/agent-ticket", { ticket });
    healthy("agent-ticket");
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 400)) {
      log(`agent ticket refused: HTTP ${e.status}`);
      return { ok: false, code: "ticket_invalid", message: INVALID };
    }
    trouble("agent-ticket", e);
    return { ok: false, code: "unavailable", message: UNAVAILABLE };
  }
  const identity = parseIdentity(body);
  if (!identity) {
    trouble("agent-ticket", new Error("malformed answer"));
    return { ok: false, code: "unavailable", message: UNAVAILABLE };
  }
  return { ok: true, identity };
}

function parseIdentity(b: any): AgentIdentity | null {
  const uuid = normUuid(b?.uuid);
  const name = typeof b?.name === "string" ? b.name : "";
  const agentId = typeof b?.agentId === "string" ? b.agentId.slice(0, 64) : "";
  if (uuid.length !== 32 || !/^[A-Za-z0-9_]{1,16}$/.test(name) || !agentId) return null;
  const serverId = typeof b.serverId === "string" && b.serverId ? b.serverId.slice(0, 64) : null;
  return { uuid, name, agentId, serverId };
}

function expired(ticket: string): boolean {
  const part = ticket.split(".")[1];
  if (!part) return false;
  try {
    const exp = Number(JSON.parse(Buffer.from(part, "base64url").toString("utf8"))?.exp);
    return Number.isFinite(exp) && exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}
