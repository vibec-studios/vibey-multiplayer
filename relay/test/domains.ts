// Several domains (DOMAINS), reserved names, the DOMAIN fallback and a stable RELAY_ID: npm test

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DOMAIN, assert, echoServer, expectText, handshake, hostSession, join, loginStart, startRelay, statusRequest } from "./util.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f: string) => pathToFileURL(path.join(here, "..", "src", f)).href;
const OLD = "old.test";

/** Imports the relay modules in a fresh process with exactly `env` (no DOMAIN/DOMAINS/RELAY_ID from outside). */
function probe(env: Record<string, string>, hosts: string[] = []) {
  const clean = { ...process.env };
  for (const k of ["DOMAIN", "DOMAINS", "RELAY_ID", "PUBLIC_PORT", "PORT"]) delete clean[k];
  const code = `
    const c = await import(${JSON.stringify(src("config.ts"))});
    const a = await import(${JSON.stringify(src("addresses.ts"))});
    const hosts = JSON.parse(process.env.PROBE_HOSTS);
    console.log(JSON.stringify({
      domains: c.DOMAINS, domain: c.DOMAIN, relayId: c.RELAY_ID, address: a.addressOf("mossy-otter-27"),
      labels: Object.fromEntries(hosts.map((h) => [h, a.labelFromHost(h)])),
    }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...clean, ...env, PROBE_HOSTS: JSON.stringify(hosts) }, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("probe failed: " + r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // ------------------------------------------------------------------------------------------------ configuration
  {
    const none = probe({});
    assert(same(none.domains, ["vibey.henny.dev"]) && none.relayId === "vibey.henny.dev",
      "no DOMAIN/DOMAINS: vibey.henny.dev, relay id vibey.henny.dev (unchanged)");

    const single = probe({ DOMAIN: " Play.Example. " });
    assert(same(single.domains, ["play.example"]) && single.relayId === "play.example", "DOMAIN still works as one domain");

    const official = probe({ DOMAINS: "axolite.cc,vibey.henny.dev" });
    assert(official.domain === "axolite.cc" && same(official.domains, ["axolite.cc", "vibey.henny.dev"]),
      "DOMAINS: the first one is the primary");
    assert(official.relayId === "vibey.henny.dev", "relay id stays vibey.henny.dev when axolite.cc becomes primary");
    assert(official.address === "mossy-otter-27.axolite.cc", "addresses use the primary domain");

    const both = probe({ DOMAINS: "a.example, B.example.,a.example", DOMAIN: "ignored.example" });
    assert(same(both.domains, ["a.example", "b.example"]), "DOMAINS wins over DOMAIN, is trimmed, lowercased, deduplicated");
    assert(both.relayId === "a.example", "other relays: relay id is the primary domain");

    const empty = probe({ DOMAINS: " , ", DOMAIN: "fallback.example" });
    assert(same(empty.domains, ["fallback.example"]), "an empty DOMAINS falls back to DOMAIN");

    const pinned = probe({ DOMAINS: "axolite.cc,vibey.henny.dev", RELAY_ID: "worker-2" });
    assert(pinned.relayId === "worker-2", "an explicit RELAY_ID wins");
  }

  // ------------------------------------------------------------------------------------------- handshake host names
  {
    const hosts = [
      "Mossy-Otter-27.axolite.cc.\0FML3\0", "mossy-otter-27.vibey.henny.dev", "MOSSY-OTTER-27.VIBEY.HENNY.DEV.",
      "x.mossy-otter-27.axolite.cc", "relay.axolite.cc", "relay.vibey.henny.dev", "www.axolite.cc", "API.axolite.cc",
      "status.vibey.henny.dev", "axolite.cc", "vibey.henny.dev", "mossy-otter-27.example.com", "mossy-otter-27.xaxolite.cc",
      "mossy-otter-27.henny.dev",
    ];
    const { labels: l } = probe({ DOMAINS: "axolite.cc,vibey.henny.dev" }, hosts);
    assert(l[hosts[0]] === "mossy-otter-27" && l[hosts[1]] === "mossy-otter-27" && l[hosts[2]] === "mossy-otter-27",
      "the same label under both domains (case, trailing dot and FML marker ignored)");
    assert(l[hosts[3]] === "mossy-otter-27", "sub-subdomains still map to the label");
    assert(hosts.slice(4, 9).every((h) => l[h] === null), "relay, www, api and status are never an address (on every domain)");
    assert(l[hosts[9]] === null && l[hosts[10]] === null, "the bare domains are no address");
    assert(l[hosts[11]] === null && l[hosts[12]] === null && l[hosts[13]] === null, "foreign host names are no address");

    const nested = probe({ DOMAINS: "henny.dev,vibey.henny.dev" }, ["mossy-otter-27.vibey.henny.dev", "mossy-otter-27.henny.dev"]);
    assert(nested.labels["mossy-otter-27.vibey.henny.dev"] === "mossy-otter-27" && nested.labels["mossy-otter-27.henny.dev"] === "mossy-otter-27",
      "a domain that ends another one does not steal its names (longest match)");
  }

  // ------------------------------------------------------------------------------------------------- end to end
  const relay = await startRelay({ DOMAINS: `${DOMAIN},${OLD}` });
  const mc = await echoServer();
  try {
    const host = await hostSession(relay.port, mc.port);
    const r = host.ready;
    assert(r.t === "ready" && r.domain === DOMAIN && r.address.startsWith(`${r.label}.${DOMAIN}`), "ready uses the primary domain: " + r.address);

    const viaNew = await join(relay.port, r.label, "Alex");
    const viaOld = await join(relay.port, r.label, "Bob", OLD);
    assert(viaNew.data.startsWith("MC:") && viaOld.data.startsWith("MC:"), "the address works under the primary and the old domain");
    assert(host.opens.some((o) => o.name === "Alex") && host.opens.some((o) => o.name === "Bob"), "both reach the same host");
    viaNew.sock.destroy();
    viaOld.sock.destroy();

    for (const name of ["relay", "www", "api", "status"]) {
      for (const d of [DOMAIN, OLD]) {
        assert(await expectText(relay.port, Buffer.concat([handshake(`${name}.${d}`, 2), loginStart("Steve")]), "Unknown address"),
          `${name}.${d} is an unknown address`);
      }
    }
    assert(await expectText(relay.port, Buffer.concat([handshake(`${r.label}.elsewhere.test`, 1), statusRequest()]), "Unknown address"),
      "a domain that is not configured is unknown");

    const st = await (await fetch(`http://127.0.0.1:${relay.httpPort}/status`)).json();
    assert(st.domain === DOMAIN && same(st.domains, [DOMAIN, OLD]), "status API names the primary domain first");
    host.ctl.destroy();

    console.log("\nall domain checks passed");
  } finally {
    mc.close();
    await relay.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
