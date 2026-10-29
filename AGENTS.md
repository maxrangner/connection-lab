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
  App.ts                     wiring: simulate → schedule → scene; settings; gates; lose-a-frame; keys; dev hook window.__ie
  timeline/schedule.ts       SimResult → visual schedule (tracks, flights, bubbles, acts, gates, timers, tcpSpans, deviceStateAt)
  timeline/Player.ts         playhead (v), rAF loop, speed, playTo (step), gates (blockedAt / release)
  content/speech.ts          what each machine says per event (SpeechWriter); content/format.ts time/rate formatting
  content/layers.ts          layer colors and names (TCP/IP vs OSI)
  iso/project.ts, prims.ts   2:1 isometric projection; extruded boxes, cylinders, plates, screen-aligned billboards; shading
  iso/layout.ts              world geometry: towers (floors, slots, ports, sockets), cables (axis-aligned polylines), bounds
  iso/IsoScene.ts            the scene: factories, gizmo poses from track keyframes, trains, bubbles, hints, operator input
  iso/machines/Machine.ts    MachineKind tables: machinesFor(deviceKind), machineFor(event) (shared by speech, scene, tests)
  iso/machines/build.ts      one builder per machine (browser, dnsDesk, httpShelf, tcpClerk, netStation, natDesk, linkStation, port)
  iso/Train.ts               a frame on a cable: cars in byte order (preamble pilot first) with real-bit pulses; loss fizzle
  iso/Bubbles.ts, Camera.ts  HTML speech bubbles anchored to machines; viewBox camera (follow / overview / free)
  gizmo/Gizmo.ts             PduSnapshot → parts (core, module, bracket, plate, shellFront/Back, frame, filler), byte-true lengths
  gizmo/GizmoView.ts         SVG for one gizmo, posed per frame (grow = bolt on/off, scatter = to/from the port, diff = changed bytes)
  scene/UrlCard.ts, svg.ts   draggable URL card (real ASCII bits, inertia, spring snap); SVG helpers
  panels/                    Inspector (clean/full/hex, device tables), Controls (transport, scrubber), Receipt, SettingsPanel
src/styles/app.css           all styling; layer colors as CSS vars mirror content/layers.ts
scripts/                     capture, event dump, screenshot scripts (Playwright)
tests/fixtures/              raw captured bytes
```

## UI model (how the animation works)

1. `runScenario` produces the event log. `buildSchedule` walks it once and assigns each event a visual start time `v` with a duration from `BASE_COST` (shortened as the same kind of event repeats). Frames in flight get a minimum travel time; idle sim gaps with nothing on the wire become short fast-forwards (`skips`) with a clock overlay.
2. **Factories.** Each device is an isometric tower, one floor per layer (hosts 5, routers 3), one machine per floor (plus the NAT desk on the home router's network floor, and one port per interface on the physical floor). Machines are plain SVG shapes with one motion each, driven by their current **act** (the event they perform) and the **device state** at v (ARP cache, NAT table, TCP state, outstanding segments, timers) from `deviceStateAt`.
3. **Gizmos.** A packet is a gizmo of parts whose lengths are proportional to their real bytes (`BYTE_PX` per byte; app payload > 64 B collapses with a label). A **track** is one packet inside one device; its keyframes (`appear`, `encap`, `decap`, `change`, `rx`, `tx`) move the gizmo between floors and set its pose (outer layer bolting on/off, parts scattering to/from the port, changed-byte highlight). Gizmos sit on the front edge of every floor and machines stand behind them, so painter's order holds without sorting. Floors are tall (`FLOOR_H`) and shallow (`FD`) on purpose: a slab hides everything on the floor below with `y < FD − (FLOOR_H − height)`.
4. **Trains.** A **flight** is one frame on one cable: the gizmo unbolted into cars in byte order (grey preamble pilot first), each with a pulse of its own bits. Lost frames tip off the cable at `lostAt`.
5. **Words.** No narrator: **bubbles** come from the acting machine (`speech.ts`), other factories dim, and the **receipt** lists everything said so far. **Gates** are visual times playback will not cross by itself: one per bubble (setting "step through bubbles") and three operator gates after the URL drop (press the megaphone, drag the cell into the TCP chassis, pull the lever; setting "You operate"). The Player stops at a gate (`blockedAt`) until `release()`; seeking and scrubbing never block.
6. The scene is a pure function of v. The follow camera frames the speaking device or both ends of the active cable, inside the part of the stage not covered by the inspector.

To check visuals, run `npm run dev`, then `node scripts/screenshot.mjs` (sampled bubbles; `SHOTS=12.5,40` for specific `v`, `SETTINGS='{"mss":536,"loss":0.15,"seed":4}'`) and `node scripts/screenshot-flows.mjs` (inspector, device panel, packet loss, receipt, OSI, operator gates, step-through, tablet). Screenshots go to `screenshots/` (git-ignored). The dev hook `window.__ie` (seek, play, start, release, info, pickFlight, pickDevice, settings, lose, receipt, v) exists only in dev builds.

## Key concepts

- **Packet vs. PDU snapshot.** A `PacketInfo` is a logical packet (`pk12`, label "SYN"). It keeps its id across hops. A `PduSnapshot` (`pdu40`) is the exact bytes at one moment (e.g. the frame on one link). Every `encapsulate`/`decapsulate`/`tx`/`forward`/`nat:translate` event points at a snapshot. Retransmissions are new packets with `retransmitOf`.
- **Layer numbers** in the sim are TCP/IP 5-layer (1 physical … 5 application). The UI maps to OSI names when that setting is on.
- **Stream packets** (`kind: 'stream'`) are application bytes handed to TCP or reassembled from it; they never cross a link.
- **Determinism / faults.** Same scenario + seed + FaultPlan ⇒ identical event log. Random loss is keyed by `hash(seed, link, packet)` so adding a manual fault never changes events before it (tested).

## How to add things

- **A new protocol:** add `src/sim/proto/<p>.ts` with `build`, `parse`, `describe` (absolute offsets, explanations), wire it into `decode.ts`, add the name to `Protocol` and `PROTOCOL_LAYER`, add codec tests with known-good bytes.
- **A new scenario:** add `src/sim/scenarios/<name>.ts` returning a `Scenario` (devices with ifaces/routes/ARP seeds/apps/layout, links with real-ish speeds, delays, a map `label` and a prose `name`). Add app behaviour in `stack/apps.ts` if needed. Give new events speech in `content/speech.ts` and a machine in `iso/machines/Machine.ts#machineFor` (the speech test enforces both), and world positions and port sides in `iso/layout.ts`. Add a test in the style of `src/sim/run.test.ts`; `src/ui/timeline/schedule.test.ts` shows how to fuzz the schedule over seeds and loss. A scenario picker in the header does not exist yet (only one scenario).
- **A new event type:** add it to `SimEventPayload`, emit it from the sim, give it a cost in `BASE_COST` (schedule.ts), map it to a machine in `machineFor`, give it speech, and animate the machine's `render` for it if it should move something.
- **A new device kind:** `DeviceKind` in `model.ts`, floors in `iso/layout.ts#floorsFor`, machines in `machinesFor`, a blurb in the inspector's device view.
- **A new machine:** a builder in `iso/machines/build.ts` (static shapes built once, one motion in `render`), a kind in the `Machine.ts` tables; the nameplate and bubble anchor come for free.

## Real-world facts and simplifications (keep honest)

- example.com resolves to Cloudflare addresses; captured values live in `src/sim/scenarios/exampleComCapture.ts` (re-capture with the script). The HTTP response is the verbatim captured bytes (chunked, 932 bytes as of 2026-10-29).
- Home public IP `203.0.113.7` and ISP backbone `198.51.100.0/24` are RFC 5737 documentation ranges standing in for real ones. MAC addresses are plausible but invented.
- The laptop behaves like Linux: TTL 64, ephemeral ports 32768–60999, SYN options MSS/SACK-permitted/timestamps/NOP/window scale 7, glibc DNS timeout 5 s × 2 attempts. TCP RTO follows RFC 6298 (1 s minimum).
- Under random loss the DNS lookup often fails: like glibc, the stub resolver sends the question at most twice, 5 s apart. That is the real behaviour, not a bug.
- Simplifications to state in the UI: the real internet path has ~10 routers, we show one ISP router; the resolver answers from cache (no recursive lookup shown); the LAN is wired Ethernet (Wi-Fi uses 802.11 framing); no IPv6, no TLS in this scenario; ACKs are sent immediately (Linux "quickack" at connection start), not delayed.
