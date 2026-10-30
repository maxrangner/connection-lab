# AGENTS.md — How the Internet Works (interactive educator)

Guidance for AI agents and humans working on this repo. Read this before changing code.

## What this is

An interactive web page that shows what really happens when a laptop fetches `http://example.com/`. The viewer drags a site card onto the laptop; a **protocol-accurate simulation** runs (ARP → DNS over UDP → TCP handshake → HTTP GET → response → FIN teardown) across a small network of isometric devices (laptop on an Ethernet cable or phone on Wi-Fi → home router with NAT → ISP router → DNS resolver / web server, optionally through a VPN server), and the page follows the packets a learner needs in chapters: **Find the address** (DNS), **Say hello** (SYN, SYN-ACK, ACK), **Agree on a secret** (TLS 1.3 handshake, HTTPS only), **Get the page** (GET, 200 OK). Chapter numbers follow what a run actually has.

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
| `node scripts/capture-tls.mjs [host] [path]` | Capture a real TLS 1.3 session (every byte both ways + its key log) into `src/sim/scenarios/tlsCapture_<host>.ts` (in Git Bash prefix `MSYS_NO_PATHCONV=1` so the path is not rewritten) |
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
  proto/wifi.ts              IEEE 802.11 data frames (To DS / From DS, three addresses, LLC/SNAP, FCS) for the phone's Wi-Fi hop
  proto/tls.ts               TLS 1.3 records: split, open with a session's keys (handshake keys until Finished, then app keys), describe
  crypto/crypto.ts           SHA-256, HMAC, HKDF-Expand-Label, AES-128-GCM decrypt, ChaCha20-Poly1305 (synchronous, plain TS; tested against NIST/RFC vectors)
  proto/wireguard.ts         WireGuard transport messages: build, open, describe (ChaCha20-Poly1305 in crypto/crypto.ts, RFC 8439 vectors)
  proto/decode.ts            decodePdu(bytes, firstProtocol) → LayerPdu[] (outermost first)
  stack/World.ts             World + Link (serialization + propagation delay, fault drops)
  stack/Device.ts            shared Ethernet/ARP/IPv4 routing for all devices
  stack/Host.ts              end host: UDP/TCP sockets, IP output
  stack/Router.ts            forwarding, TTL, NAT (natRewrite recomputes checksums)
  stack/tcp.ts               TCP state machine, RFC 6298 RTO, dup ACKs, SACK, FIN teardown
  stack/apps.ts              browser + DNS stub, DNS resolver, HTTP server
  stack/vpn.ts               WireGuard tunnel: TunnelClient on the device, VpnServer that opens packets, NATs them to its own address and seals replies
  stack/https.ts             HTTPS over a captured TLS session: both ends replay their real flights in turn and decrypt the other side
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
  stickers.ts                Secure and Bigger page stickers; stick onto the card (or tap)
  props.ts                   things on the table you put to work by hand: cloud, spyglass, scissors, satellite, VPN shield
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
4. **HTTPS (🔒 Secure sticker, scenario option `https`).** Port 443, a real captured TLS 1.3 session (`scripts/capture-tls.mjs`). Each side sends its captured flight once the other side's earlier flights have arrived, and learns what the other said only by decrypting its records with the session's traffic secrets (the key-log approach: the ECDHE exchange that produced them cannot be redone). The story opens every segment's records to name it (`labelTls`): hellos travel open; the certificate, signature, Finished, the GET, the page and the close are **locked** cards, with their own `lock` and `unlock` steps (`lockPose`): a physical padlock drops on open, the session key flies in and turns, the shackle snaps shut and the card goes dark; at the far end the same-shaped key opens it and the padlock lifts away. Each end gets its key when it has read the other side's last open hello (`Timeline.keys`): both compute the same secret, so the keys match. Routers never see inside, not even when you peek. Several packets of one flight are numbered and only the last gets a reaction (`Trip.quiet`).
4. **Interaction: everything is done by hand on the table.** Do not add settings buttons; add a physical thing. The bar holds only ⏮ ⏸ ⏭ ♪ ↺ (and "Follow packet" after you move the view).
   - **Site card:** rests between the laptop and the phone. Drop it on the **laptop** (Ethernet cable) or the **phone** (Wi-Fi; scenario option `from`); the device not used greys out. On Wi-Fi the packet flies through the air in a teal **Wi-Fi sleeve** (802.11 header 32 B incl. LLC/SNAP) and the home router swaps it for an orange Ethernet sleeve (`Frame` on wrap/unwrap steps, `frameAt(seg)`). When a run ends the card floats back and the table keeps the final picture (`idleV`), ready to go again.
   - **Second visit:** drag the card in again and the device still remembers the address (scenario option `revisit`), so it skips the lookup and ARP. It lasts for the DNS record's real TTL (`Story.dnsTtl`), per device and site. Tap a remembered screen between runs to forget. There is no sticker for this.
   - **Stickers on the card:** **Secure** (HTTPS) and **Bigger page** (the first website, whose reply needs numbered packets that slot into a rack beside the device before the page shows).
   - **Cloud** (`Prop`): waits beside the buttons, always in reach. Put it on any line and only that line gets random loss, shown as crackling along the link's real path (`linkWorld`), up the beams on a satellite hop; a packet the storm takes gets a lightning bolt and a zap. Drop it on another line to move the storm; tap it, or the faint outline it leaves by the buttons, to end it. Works any time: mid-run, `seenSoFar(tl, v)` freezes every frame that has set off (`FaultPlan.decided`) and the storm applies from that sim time on (`FaultPlan.lossWindows`, one line per window). Each run draws new weather.
   - **Spyglass** (`lineTool`): put it on any line. A note shows what anyone on that line can read from each passing frame, computed from the real bytes with no keys (`Seen`, `seenOn`): addresses and plain HTTP or DNS; with HTTPS only scrambled bytes, except the site name from the ClientHello's SNI extension (`clientHelloSni`); with a VPN only scrambled bytes to the VPN server. Changes nothing about the run.
   - **Scissors** (`lineTool`, cables only; radio cannot be cut): every frame sent on that cable is lost (`FaultPlan.cuts`, drop reason `cut`), also mid-run, when a packet riding it falls in. Resends back off for real (1, 2, 4 ... s, 60 s at most), each with a longer ring and each trip faster than the last, until the sender gives up or you mend the cable by tapping the scissors. A cable already cut at the start warms the ARP caches (`warmArp`) so the first thing to fall is a packet you can see.
   - **Shield** (`Prop`): stand it on the VPN server's faint spot, between runs only. Scenario option `vpn`: every packet of the device goes into a WireGuard tunnel to the VPN server, DNS too. The story has `wrap`/`unwrap` steps with layer `vpn` (they carry the addresses showing from there on, for `addressBefore`). Inside the dark case the IP, transport and card pieces are sealed: no labels, and peeking shows only sizes. Past the VPN server the packet is ordinary again, sent from its address.
   - **Satellite** (`Prop`): put it on the line to the ISP, between runs only (it would change the past): scenario option `slow`, a geostationary link, 280 ms each way, 25 Mbit/s, drawn as a hop the packet climbs (`Timeline.sky`).
   - **Packets:** tap one riding a cable to knock it off (anime burst, tumble, the resender's timer, "!", retry); tap it anywhere else, or paused, to pop it open with real sizes.
   - **Step buttons / arrow keys:** one action at a time (`stepTarget`). The animation really plays, in 0.22–0.5 s and without sounds, then carries on as it was, playing or paused.
   - **Reset (↺):** back to a clean table from anywhere: stickers off, cloud and satellite home, memories gone.
   - **View:** drag, pinch or wheel lets go of the follow camera.
5. **Greying out and chapters.** Once a run starts, devices (and their cables) that no trip of this run visits are greyed out, e.g. the DNS resolver on a revisit. The chapter label is a button: it opens a list of this run's chapters to jump to.
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
- HTTPS replays a captured session, so its random values, certificate and keys are the real ones from the capture day; the handshake secrets are taken from the key log rather than re-derived from the ECDHE exchange. Cipher suite TLS_AES_128_GCM_SHA256. The card says "hello" for ClientHello/ServerHello, "certificate", "signature" (CertificateVerify), "done" (Finished), "ticket" (NewSessionTicket), "bye" (close_notify).
- The VPN is real WireGuard transport messages (ChaCha20-Poly1305, padded to 16 bytes), but the tunnel is already up: the Noise handshake is not shown and the session keys come from the seeded Rng. MSS is 1380 in a tunnel, as for WireGuard's usual MTU of 1420. Sim tests open the sealed bytes from the ISP line with the session key.
- The phone's Wi-Fi is an open network: real home Wi-Fi encrypts frame bodies (WPA2/WPA3 adds a CCMP header and an 8-byte MIC). No QoS field and no link-layer ACK frames are shown. A real home router bridges its Wi-Fi and Ethernet ports into one network with one address; the sim models that bridge as two interfaces sharing 192.168.1.1 plus a host route to the phone. The phone sends the same captured request bytes as the laptop.
- Simplifications to state in the UI: the real internet path has ~10 routers, we show one ISP router; the resolver answers from cache (no recursive lookup shown); the LAN is wired Ethernet (Wi-Fi uses 802.11 framing); no IPv6, no TLS in this scenario; ACKs are sent immediately (Linux "quickack" at connection start), not delayed.
