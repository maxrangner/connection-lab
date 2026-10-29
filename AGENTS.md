# AGENTS.md — How the Internet Works (interactive educator)

Guidance for AI agents and humans working on this repo. Read this before changing code.

## What this is

An interactive web page that shows what really happens when a laptop fetches `http://example.com/`. The user drags a URL card into a laptop; a **protocol-accurate simulation** runs (ARP → DNS over UDP → TCP handshake → HTTP GET → response → FIN teardown) across a map of devices (laptop → home router with NAT → ISP router → DNS resolver / web server), and the UI animates every frame as byte blocks moving between devices, being wrapped and unwrapped layer by layer.

Audience: CS-student level. Visually clean by default, with pause-and-expand for full detail.

## Non-negotiables

1. **Protocol realism.** Every byte shown is a real byte the simulation produced: real header layouts, real field values, real checksums (IPv4, UDP, TCP pseudo-header, Ethernet CRC-32). Never fake a field for the UI. If a teaching need conflicts with realism, expose a *real* knob (e.g. MSS 1460/536) instead of inventing data.
2. **`src/sim` is headless and deterministic.** It must not import from `src/ui` or touch `window`/`document`/`Date`/`Math.random`. ESLint enforces this. All randomness goes through the seeded `Rng` (`src/sim/core/Rng.ts`).
3. **The UI only renders the event log.** The UI never decides protocol behaviour. It reads `SimResult` (events, PDU snapshots, packets) and animates it. "Lose this packet" re-runs the sim with a `FaultPlan`; it does not patch the animation.
4. **Receivers decode bytes.** Devices parse incoming bytes with the same codecs the inspector uses; nothing trusts sender-side metadata.
5. **Every field has an explanation.** Each `Field` produced by a describer needs a non-empty `explain` (a test enforces it). Tag fields `importance: 'key'` (clean view) or `'detail'` (full/hex views).
6. **The scene is a pure function of visual time `v`.** `Scene.render(v)` must draw the same picture for the same `v` no matter how you got there (playing, scrubbing backward, stepping). Never accumulate state across frames except the camera smoothing and the URL card's physics. This is what makes pause/step/scrub and "lose this packet" (re-simulate, rebuild, seek) trivial.
7. **Graphics: simple shapes first** (SVG rects, circles, paths). If a richer illustration would help, write an image-generation prompt for the user (they generate it with ChatGPT) and leave an asset slot. Do not hand-draw complex art.

## Commands

The machine may not have Node on `PATH` in every shell. If `node` is missing in Git Bash, prefix with `export PATH="/c/Program Files/nodejs:$PATH";`.

| Command | What |
|---|---|
| `npm run dev` | Vite dev server |
| `npm test` | Vitest (sim core + codecs) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (incl. sim/UI boundary) |
| `npm run build` | typecheck + static build to `dist/` |
| `npx vite-node scripts/dump-events.ts [mss] [lose:<packetId>@<linkId>]` | Print a scenario's full event log (debugging) |
| `node scripts/screenshot.mjs` / `node scripts/screenshot-flows.mjs` | Headless screenshots of the running dev server (see "UI model") |
| `node scripts/capture-example-com.mjs` | Re-capture the real example.com response (regenerates `src/sim/scenarios/exampleComCapture.ts` and `tests/fixtures/*.http`) |

Run `npm run typecheck && npm run lint && npm test` before declaring work done.

## Directory map

```
src/sim/                     headless protocol simulation (no DOM)
  bytes/                     addr (MAC/IP), ByteWriter + helpers, checksum (RFC 1071, CRC-32)
  core/Rng.ts                seeded mulberry32 + hash32
  core/Simulator.ts          discrete-event queue, event log, PDU snapshots, packet registry
  events/SimEvent.ts         the event union the UI consumes
  proto/                     one file per protocol: build*, parse*, describe* (fields with offsets + explanations)
  proto/decode.ts            decodePdu(bytes, firstProtocol) → LayerPdu[] (outermost first)
  stack/World.ts             World + Link (serialization + propagation delay, fault drops)
  stack/Device.ts            shared Ethernet/ARP/IPv4 routing for all devices
  stack/Host.ts              end host: UDP/TCP sockets, IP output
  stack/Router.ts            forwarding, TTL, NAT (natRewrite recomputes checksums)
  stack/tcp.ts               TCP state machine, RFC 6298 RTO, dup ACKs, SACK, FIN teardown
  stack/apps.ts              browser + DNS stub, DNS resolver, HTTP server
  scenarios/                 scenario data (topology, addresses, layout) + captured real bytes
  faults.ts                  FaultPlan: random loss keyed by hash, manual "lose this packet"
  run.ts                     runScenario(scenario, { seed, faults }) → SimResult
src/ui/                      presentation (vanilla DOM + SVG, no framework, no animation library)
  App.ts                     wiring: simulate → schedule → scene; settings; lose-a-frame; keys; dev hook window.__ie
  timeline/schedule.ts       SimResult → visual schedule (tracks, flights, badges, beats, timers, skips, time warp)
  timeline/Player.ts         playhead (v), rAF loop, speed, playTo (used by step)
  content/narration.ts       captions + badges per event (Narrator); fmtTime/fmtRate
  content/layers.ts          layer colors, names (TCP/IP vs OSI), card rows per device kind
  scene/Scene.ts             SVG map: device nodes ⇄ stack cards, strips, bit trains, badges, timers, page, camera
  scene/strip.ts             PDU → byte-block strip (1 block = 1 byte; app data > 64 B collapsed); grow/diff
  scene/wire.ts              frame → square-wave bit train (preamble first, LSB-first, decimated real bits)
  scene/UrlCard.ts           draggable URL card (real ASCII bits, inertia, wall bounce, spring snap)
  scene/geometry.ts, icons.ts, svg.ts
  panels/                    Inspector (clean/full/hex, device tables), Controls (caption, transport, scrubber), SettingsPanel
src/styles/app.css           all styling; layer colors as CSS vars mirror content/layers.ts
scripts/                     capture, event dump, screenshot scripts (Playwright)
tests/fixtures/              raw captured bytes
```

## UI model (how the animation works)

1. `runScenario` produces the event log. `buildSchedule` walks it once and assigns each event a visual start time `v` with a duration from `BASE_COST` (shortened as the same kind of event repeats). Frames in flight get a minimum travel time; idle sim gaps with nothing on the wire become short fast-forwards (`skips`) with a clock overlay.
2. A **track** is one packet inside one device: keyframes (`appear`, `encap`, `decap`, `change`, `rx`, `tx`) move its strip between layer rows and grow/shrink the outer header. A **flight** is one frame on one link. **Beats** are captioned steps (← / → step between their ends). **Badges** are short device-side notes.
3. A device's card is open while any track is inside it (`cardSpans`). The follow camera frames the device or both ends of the active link, inside the part of the stage not covered by the inspector.

To check visuals, run `npm run dev`, then `node scripts/screenshot.mjs` (sampled steps; `SHOTS=12.5,40` for specific `v`, `SETTINGS='{"mss":536,"loss":0.15,"seed":4}'`) and `node scripts/screenshot-flows.mjs` (inspector, device panel, packet loss, OSI, tablet). Screenshots go to `screenshots/` (git-ignored).

## Key concepts

- **Packet vs. PDU snapshot.** A `PacketInfo` is a logical packet (`pk12`, label "SYN"). It keeps its id across hops. A `PduSnapshot` (`pdu40`) is the exact bytes at one moment (e.g. the frame on one link). Every `encapsulate`/`decapsulate`/`tx`/`forward`/`nat:translate` event points at a snapshot. Retransmissions are new packets with `retransmitOf`.
- **Layer numbers** in the sim are TCP/IP 5-layer (1 physical … 5 application). The UI maps to OSI names when that setting is on.
- **Stream packets** (`kind: 'stream'`) are application bytes handed to TCP or reassembled from it; they never cross a link.
- **Determinism / faults.** Same scenario + seed + FaultPlan ⇒ identical event log. Random loss is keyed by `hash(seed, link, packet)` so adding a manual fault never changes events before it (tested).

## How to add things

- **A new protocol:** add `src/sim/proto/<p>.ts` with `build`, `parse`, `describe` (absolute offsets, explanations), wire it into `decode.ts`, add the name to `Protocol` and `PROTOCOL_LAYER`, add codec tests with known-good bytes.
- **A new scenario:** add `src/sim/scenarios/<name>.ts` returning a `Scenario` (devices with ifaces/routes/ARP seeds/apps/layout, links with real-ish speeds, delays, a map `label` and a prose `name`). Add app behaviour in `stack/apps.ts` if needed. Add narration for any new event/app action in `content/narration.ts`. Add a test in the style of `src/sim/run.test.ts`; `src/ui/timeline/schedule.test.ts` shows how to fuzz the schedule over seeds and loss. A scenario picker in the header does not exist yet (only one scenario).
- **A new event type:** add it to `SimEventPayload`, emit it from the sim, give it a cost in `BASE_COST` (schedule.ts), handle tracks/flights there if it moves bytes, and narrate it.
- **A new device kind:** `DeviceKind` in `model.ts`, rows in `content/layers.ts#rowsFor`, an icon in `scene/icons.ts`, a blurb in the inspector's device view.

## Real-world facts and simplifications (keep honest)

- example.com resolves to Cloudflare addresses; captured values live in `src/sim/scenarios/exampleComCapture.ts` (re-capture with the script). The HTTP response is the verbatim captured bytes (chunked, 932 bytes as of 2026-10-29).
- Home public IP `203.0.113.7` and ISP backbone `198.51.100.0/24` are RFC 5737 documentation ranges standing in for real ones. MAC addresses are plausible but invented.
- The laptop behaves like Linux: TTL 64, ephemeral ports 32768–60999, SYN options MSS/SACK-permitted/timestamps/NOP/window scale 7, glibc DNS timeout 5 s × 2 attempts. TCP RTO follows RFC 6298 (1 s minimum).
- Under random loss the DNS lookup often fails: like glibc, the stub resolver sends the question at most twice, 5 s apart. That is the real behaviour, not a bug.
- Simplifications to state in the UI: the real internet path has ~10 routers, we show one ISP router; the resolver answers from cache (no recursive lookup shown); the LAN is wired Ethernet (Wi-Fi uses 802.11 framing); no IPv6, no TLS in this scenario; ACKs are sent immediately (Linux "quickack" at connection start), not delayed.
