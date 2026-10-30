# How the Internet Works

An interactive, protocol-accurate visualization of what happens when a computer fetches a web page.

Drag the `example.com` card onto the laptop (Ethernet cable) or the phone (Wi-Fi) and follow the packets: a DNS question to the resolver and back, a three-packet "hello" to the web server, then `GET /` and the page. Each packet is packed at its sender (transport and IP collars, an Ethernet sleeve), gets a new sleeve at every router (the home router's NAT swaps the address), and is unpacked at the other end. Tap a packet on a cable to knock it off and watch the sender's timer run out and send it again; tap it anywhere else to pop it open. Before you start, stick features onto the card: a bigger page (the first website ever, which needs two packets), a second visit (the address is remembered), or satellite internet (a slow hop through space). The ⚡ Storm switch makes the internet cables lose packets at random; flip it any time, even mid-run.

Everything shown is real: header sizes, addresses, timers, and the actual bytes example.com returns.

## Run

```sh
npm install
npm run dev
```

## Develop

```sh
npm test          # simulation, codec and story tests
npm run lint
npm run typecheck
npm run build     # static site in dist/
```

See [AGENTS.md](AGENTS.md) for architecture and conventions.
