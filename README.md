# How the Internet Works

An interactive, protocol-accurate visualization of what happens when a computer fetches a web page.

Drag the `example.com` card onto the laptop (Ethernet cable) or the phone (Wi-Fi) and follow the packets: a DNS question to the resolver and back, a three-packet "hello" to the web server, then `GET /` and the page. Each packet is packed at its sender (transport and IP collars, an Ethernet sleeve), gets a new sleeve at every router (the home router's NAT swaps the address), and is unpacked at the other end. Drag the `photo.jpg` card instead and a real 35 KB picture comes down in about 25 packets at once, its ACKs coming back and TCP's window growing, filling in strip by strip. Tap a packet to pop it open. The bar below has a speed popup, a Tools popup (click lines to cut them or read what a snoop can read) and a Setup popup for the next run: Secure page (HTTPS with a real TLS 1.3 handshake, a padlock and matching keys), Bigger page (the first website ever, which needs several packets), Satellite internet, VPN and more, each with a line on what it does. The devices say what they are doing in short speech bubbles, which Quiet devices turns off. During a run the cards wait down the side of the screen: drag one onto the other device and both jobs run at once as small coloured blocks. When a run ends the card comes back; drag it in again and the device still remembers the address.

What is shown is real: header sizes, timers, the public addresses, and the actual bytes example.com returns. The home addresses and MAC addresses are made up, as AGENTS.md records.

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
