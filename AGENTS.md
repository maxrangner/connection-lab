# AGENTS.md — How the Internet Works (interactive educator)

Guidance for AI agents and humans working on this repo. Read this before changing code.

## What this is

An interactive web page that shows what really happens when a laptop fetches `http://example.com/`. The viewer drags a site card onto the laptop; a **protocol-accurate simulation** runs (ARP → DNS over UDP → TCP handshake → HTTP GET → response → FIN teardown) across a small network of isometric devices (laptop → home router with NAT → ISP router → DNS resolver / web server), and the page follows the packets a learner needs in three chapters: **1 Find the address** (DNS), **2 Say hello** (SYN, SYN-ACK, ACK), **3 Get the page** (GET, 200 OK).

Audience: curious learners up to CS-student level. **Simple, fun and educational; playful interactions; never overwhelming.** Learning happens by watching: no narration, no explanatory pop-ups or captions, only short labels on things (device names, "TCP", an address). When in doubt, show less.

## Non-negotiables

1. **Protocol realism.** Every byte shown is a real byte the simulation produced: real header layouts, real field values, real checksums (IPv4, UDP, TCP pseudo-header, Ethernet CRC-32). Never fake a field for the UI. If a teaching need conflicts with realism, expose a *real* knob (e.g. MSS 1460/536) instead of inventing data.
2. **`src/sim` is headless and deterministic.** It must not import from `src/ui` or touch `window`/`document`/`Date`/`Math.random`. ESLint enforces this. All randomness goes through the seeded `Rng` (`src/sim/core/Rng.ts`).
3. **The UI only renders the event log.** The UI never decides protocol behaviour. It reads `SimResult` (events, PDU snapshots, packets) and animates it. "Lose this packet" re-runs the sim with a `FaultPlan`; it does not patch the animation.
4. **Receivers decode bytes.** Devices parse incoming bytes with the same codecs the UI reads; nothing trusts sender-side metadata.
5. **Every field has an explanation.** Each `Field` produced by a describer needs a non-empty `explain` (a test enforces it). Tag fields `importance: 'key'` (the short view) or `'detail'` (full detail).
6. **The scene is a pure function of visual time `v`.** `NetworkScene.render(v)` / `drawPacket(v, peek)` must draw the same picture for the same `v` no matter how you got there. Never accumulate state across frames except the camera smoothing, the peek easing and the site card's drag/spring. This is what makes pause, seeking and "knock this packet off" (re-simulate, rebuild the timeline, keep `v`) trivial.
7. **Graphics: simple shapes first** (SVG rects, circles, paths). If a richer illustration would help, write an image-generation prompt for the user (they generate it with ChatGPT) and leave an asset slot. Do not hand-draw complex art.

## Commands

The machine may not have Node on `PATH` in every shell. If `node` is missing in Git Bash, prefix with `export PATH="/c/Program Files/nodejs:$PATH";`.

| Command | What |
|---|---|
| `npm run dev` | Vite dev server |
| `npm test` | Vitest (sim core, codecs, story/timeline) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (incl. sim/UI boundary) |
| `npm run build` | typecheck + static build to `dist/` |
| `npx vite-node scripts/dump-events.ts [mss] [lose:<packetId>@<linkId>]` | Print a scenario's full event log (debugging) |
| `node scripts/screenshot.mjs [url] [outDir] [w] [h]` | Headless screenshots of the running dev server: key moments of each chapter, then a knocked-off packet, its timer and the retry (`SHOTS=12.5,40` for specific `v`) |
| `node scripts/bundle.mjs [outFile]` | One self-contained HTML file (inline JS/CSS) to share or publish as an artifact; default `dist-bundle/get-example-com.html` |
| `node scripts/capture-info-cern.mjs` | Re-capture the first website (info.cern.ch/hypertext/WWW/TheProject.html, 2450 bytes) for the "Bigger page" sticker |
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
  main.ts                    wiring: simulate → story → timeline → scene; site card drag; knock/peek taps; pan/zoom; controls;
                             chapter label; sound cues; dev hook window.__net (seek, knock, segs, total, reset)
  story.ts                   SimResult → Story: which packets to follow (DNS, handshake, data; not ARP, plain ACKs, teardown)
                             and each one's steps (appear, wrap, travel, unwrap, nat, lost, read), real header sizes, addresses
  timeline.ts                Story → segments with visual start/end, device positions, packet facing and turns, lost/tumble,
                             timer waits, sound cues; pure helpers packetPos, wrapsBefore, addressBefore, trayOpacity, chapterAt
  NetworkScene.ts            the scene: devices, cables, layer trays, the packet (card + transport/IP collars + Ethernet sleeve),
                             address tag, peek chips, impact burst, timer and "!", laptop screen; cameras (overview/follow)
  sound.ts                   synthesized effects (WebAudio), muted with one button
  stickers.ts                start-screen configurator: sticker sheet; drag onto the card (or tap) to switch a feature on
  project.ts, prims.ts       2:1 isometric projection and easing; extruded boxes, cylinders, tiles, lines; shade.ts face colours
  svg.ts                     SVG helpers
  app.css                    all styling (warm off-white table, layer colours)
scripts/                     capture, event dump, screenshot scripts (Playwright)
tests/fixtures/              raw captured bytes
```

## UI model (how the animation works)

1. **Story.** `buildStory` picks the packets a learner follows and turns each one's events into steps. A packet with data gets a **card** ("GET /", "example.com?", "200 OK"); an empty segment (SYN, SYN-ACK, ACK) is just its collars, labelled with its flags. Knocking a packet off (a manual fault) ends its trip with `lost`; whatever the sim sends next (a TCP retransmission after the RTO, the glibc DNS retry after 5 s) is simply the next trip, marked `retry`.
2. **Timeline.** `buildTimeline` lays the trips out one after another in visual seconds. Steps get quicker as they repeat. After a lost trip it inserts a **wait** at the resender: a ring fills (labelled with the real wait), then a surprised "!" and the retry. Knock points (`packetId@link` → progress) only shape the drawing of the fall; the protocol outcome comes from the re-simulation. Adding a knock never changes segments before it (tested).
3. **Scene.** Devices are neutral blocks; the packet is the colourful object. Header pieces are byte-proportional (`TILES_PER_BYTE`); the data card is not to scale. Byte 0 leads. Inside every device the packet lies along the trays (all trays run along x): facing +x on the way out from the laptop, −x on the way back (`trayAngle`). It turns only for a cable that branches off another way (the resolver), swinging round while it drops to the port and back while it rises at the far end (`travelPose`; a test checks the facing never jumps). Layer **trays** (hosts: Ethernet, IP, TCP/UDP, App; routers: Ethernet, IP) show only while a device works on the packet. The old Ethernet sleeve drops and bounces away at every hop; a new one slides on. NAT flips the address on the IP tag (arrow green outward, rust on the way back).
4. **Interaction.** Before starting, stick features onto the site card (drag or tap; remembered in localStorage): **Bigger page** fetches the first website, whose reply needs two numbered packets that slot into a rack beside the laptop before the page shows; **Visit again** skips the address lookup and ARP because the laptop and home router still remember (scenario option `revisit`); **Stormy** gives the internet-side cables random loss (`FaultPlan.lossyLinks`), shown as crackling cables, and a packet the storm takes gets a lightning bolt and a zap instead of a bonk. Each stormy run draws new weather. At the end, **Visit again** replays with that sticker on. Drag the site card onto the laptop to start. Tap the packet while it rides a cable (playing) to knock it off: anime impact burst, tumble, bounce, it falls apart, the resender's timer runs out, "!", retry. Tap it anywhere else (or while paused) to pop it open into pieces with their real sizes. Drag/pinch/wheel pans and zooms and lets go of the follow camera; "Follow packet" takes it back. Pause, 1×/2×, sound, Again.
5. **Words.** No narrator and no explanatory text on stage. Allowed: device names, layer names on trays and pieces, the from/to tag, byte sizes when peeking, timer seconds, the three chapter names.
6. **Emoji statuses** (`timeline.ts#arrivalFace`, `Reaction`), all derived from what really happened: 👍 a reply (or the final handshake ACK) arrives; 😍 the page is complete; 😕 a duplicate, or a page part arriving while an earlier one is missing; 😢 on a packet as it falls off a cable; at the resender's timer, "!" the first time, 😠 when its resend was lost too, 😭 when it gives up. Requests get no reaction. The camera lingers on a reaction between trips.

To check visuals, run `npm run dev`, then `node scripts/screenshot.mjs` (desktop) or `node scripts/screenshot.mjs http://localhost:5173/ screenshots/phone 390 844`. Screenshots go to `screenshots/` (git-ignored).

## Key concepts

- **Packet vs. PDU snapshot.** A `PacketInfo` is a logical packet (`pk12`, label "SYN"). It keeps its id across hops. A `PduSnapshot` (`pdu40`) is the exact bytes at one moment (e.g. the frame on one link). Every `encapsulate`/`decapsulate`/`tx`/`forward`/`nat:translate` event points at a snapshot. Retransmissions are new packets with `retransmitOf`.
- **Layer numbers** in the sim are TCP/IP 5-layer (1 physical … 5 application).
- **Stream packets** (`kind: 'stream'`) are application bytes handed to TCP or reassembled from it; they never cross a link.
- **Determinism / faults.** Same scenario + seed + FaultPlan ⇒ identical event log. Random loss is keyed by `hash(seed, link, packet)` so adding a manual fault never changes events before it (tested).

## How to add things

- **A new protocol:** add `src/sim/proto/<p>.ts` with `build`, `parse`, `describe` (absolute offsets, explanations), wire it into `decode.ts`, add the name to `Protocol` and `PROTOCOL_LAYER`, add codec tests with known-good bytes.
- **A new scenario:** add `src/sim/scenarios/<name>.ts` returning a `Scenario` (devices with ifaces/routes/ARP seeds/apps, links with real-ish speeds and delays). Add app behaviour in `stack/apps.ts` if needed and a test in the style of `src/sim/run.test.ts`. In the UI, give new device kinds a position in `timeline.ts#POS` (keep cables axis-aligned), a height in `DEVICE_TOP` and a shape in `NetworkScene#buildDevice`; teach `story.ts#chosen` which packets to follow.
- **A new kind of step:** add it to `Step` in `story.ts` (from the events), give it a duration in `timeline.ts#DUR` and a position, and draw it in `NetworkScene` (`parts`, `drawPacket`). Keep it a pure function of `v`.

## Real-world facts and simplifications (keep honest)

- example.com resolves to Cloudflare addresses; captured values live in `src/sim/scenarios/exampleComCapture.ts` (re-capture with the script). The HTTP response is the verbatim captured bytes (chunked, 932 bytes as of 2026-10-29).
- Home public IP `203.0.113.7` and ISP backbone `198.51.100.0/24` are RFC 5737 documentation ranges standing in for real ones. MAC addresses are plausible but invented.
- The laptop behaves like Linux: TTL 64, ephemeral ports 32768–60999, SYN options MSS/SACK-permitted/timestamps/NOP/window scale 7, glibc DNS timeout 5 s × 2 attempts. TCP RTO follows RFC 6298 (1 s minimum).
- Under random loss the DNS lookup often fails: like glibc, the stub resolver sends the question at most twice, 5 s apart. That is the real behaviour, not a bug.
- Simplifications to state in the UI: the real internet path has ~10 routers, we show one ISP router; the resolver answers from cache (no recursive lookup shown); the LAN is wired Ethernet (Wi-Fi uses 802.11 framing); no IPv6, no TLS in this scenario; ACKs are sent immediately (Linux "quickack" at connection start), not delayed.
