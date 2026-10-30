# How the Internet Works

An interactive, protocol-accurate visualization of what happens when a computer fetches a web page.

Drag the `example.com` card onto the laptop (Ethernet cable) or the phone (Wi-Fi) and follow the packets: a DNS question to the resolver and back, a three-packet "hello" to the web server, then `GET /` and the page. Each packet is packed at its sender (transport and IP collars, an Ethernet sleeve), gets a new sleeve at every router (the home router's NAT swaps the address), and is unpacked at the other end. Tap a packet on a cable to knock it off and watch the sender's timer run out and send it again; tap it anywhere else to pop it open. Everything is done by hand on the table. Stick Secure (HTTPS: a real TLS 1.3 handshake, then a padlock and matching keys) or Bigger page (the first website ever, which needs several packets) onto the card, put the cloud on any line for a storm on that line, or put the satellite on the line to the ISP. When a run ends the card comes back; drag it in again and the device still remembers the address.

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
