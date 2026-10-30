# How the Internet Works

An interactive, protocol-accurate visualization of what happens when a computer fetches a web page.

Drag the `example.com` card onto the laptop (Ethernet cable) or the phone (Wi-Fi) and follow the packets: a DNS question to the resolver and back, a three-packet "hello" to the web server, then `GET /` and the page. Each packet is packed at its sender (transport and IP collars, an Ethernet sleeve), gets a new sleeve at every router (the home router's NAT swaps the address), and is unpacked at the other end. Tap a packet to pop it open. The bar below has a speed popup, a Tools popup (click lines to storm them, cut them or read what a snoop can read) and a Setup popup for the next run: Secure (HTTPS with a real TLS 1.3 handshake, a padlock and matching keys), Bigger page (the first website ever, which needs several packets), Satellite, and VPN. When a run ends the card comes back; drag it in again and the device still remembers the address.

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
