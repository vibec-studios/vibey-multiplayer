import { BACKEND_EVENTS_MS, BACKEND_EVENT_BUFFER, log } from "./config.ts";

export type RelayEvent = {
  type: "host_online" | "host_offline" | "player_join" | "player_leave" | "blocked";
  uuid: string;
  slot: number;
  address: string;
  at: string;
  player?: { name: string; uuid: string };
  ip?: string;
};

type Sink = (events: RelayEvent[]) => Promise<boolean>;

const BATCH = 500;
const queue: RelayEvent[] = [];
let sink: Sink | null = null;
let busy = false;
let failures = 0;
let dropped = 0;
let nextTry = 0;

/** Queues an event for the backend. Never blocks and never throws; without a backend it does nothing. */
export function emit(e: Omit<RelayEvent, "at">) {
  if (!sink) return;
  queue.push({ ...e, at: new Date().toISOString() });
  if (queue.length > BACKEND_EVENT_BUFFER) {
    dropped += queue.length - BACKEND_EVENT_BUFFER;
    queue.splice(0, queue.length - BACKEND_EVENT_BUFFER);
  }
}

export function pendingEvents(): number {
  return queue.length;
}

/** Sends queued events in batches every BACKEND_EVENTS_MS; failed batches stay queued (oldest dropped when full). */
export function startEvents(send: Sink): NodeJS.Timeout {
  sink = send;
  return setInterval(() => void flushEvents(), BACKEND_EVENTS_MS).unref();
}

export async function flushEvents() {
  if (!sink || busy || !queue.length || Date.now() < nextTry) return;
  busy = true;
  try {
    while (queue.length) {
      const batch = queue.slice(0, BATCH);
      if (!(await sink(batch))) {
        failures++;
        // Back off up to a minute; events keep queueing meanwhile.
        nextTry = Date.now() + Math.min(60_000, BACKEND_EVENTS_MS * 2 ** Math.min(failures, 5));
        return;
      }
      // New events are appended and the cap drops from the front, so the sent events are still a prefix.
      queue.splice(0, queue.indexOf(batch[batch.length - 1]) + 1);
      if (dropped) log(`backend: event buffer was full, dropped ${dropped} old events`);
      dropped = 0;
      failures = 0;
    }
  } finally {
    busy = false;
  }
}
