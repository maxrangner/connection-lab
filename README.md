# How the Internet Works

An interactive, protocol-accurate visualization of what happens when a computer fetches a web page.

Drag the `http://example.com/` card into the laptop factory and watch little machines build the request into a gizmo of parts: a TCP chassis, an IP plate and an Ethernet shell, each as long as its real bytes. The port unbolts it into a train of parts that rides the cable, bit by bit, through a home router (with NAT), an ISP router and the internet, and the response comes back the same way. Every machine says what it is doing. Pause at any moment, click a part or a train and inspect every header field, lose a frame and watch TCP recover, or switch on operator mode and work the machines yourself.

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
