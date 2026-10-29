# How the Internet Works

An interactive, protocol-accurate visualization of what happens when a computer fetches a web page.

Drag the `http://example.com/` card into the laptop and watch the request turn into bytes, get wrapped in TCP, IP and Ethernet headers, travel as bits across a home router (with NAT), an ISP router and the internet, and come back as a response. Pause at any moment, click a packet and inspect every header field, or lose a packet and watch TCP recover.

Everything shown is real: header layouts, field values, checksums, timers, and the actual bytes example.com returns.

## Run

```sh
npm install
npm run dev
```

## Develop

```sh
npm test          # simulation + codec tests
npm run lint
npm run typecheck
npm run build     # static site in dist/
```

See [AGENTS.md](AGENTS.md) for architecture and conventions.
