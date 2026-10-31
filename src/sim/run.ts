import type { PacketInfo, PduSnapshot } from './core/Simulator';
import type { SimEvent } from './events/SimEvent';
import { NO_FAULTS, type FaultPlan } from './faults';
import type { Scenario } from './model';
import { startBrowser, startDnsServer, startHttpServer } from './stack/apps';
import { startHttpsServer } from './stack/https';
import { TunnelClient, VpnServer } from './stack/vpn';
import type { Device } from './stack/Device';
import { Host } from './stack/Host';
import { Router } from './stack/Router';
import { Link, World } from './stack/World';

export interface RunOptions {
  seed: number;
  faults?: FaultPlan;
  /** Stop the clock here even if timers are still pending (seconds). */
  maxTime?: number;
}

export interface SimResult {
  scenario: Scenario;
  seed: number;
  faults: FaultPlan;
  events: SimEvent[];
  pdus: Map<string, PduSnapshot>;
  packets: Map<string, PacketInfo>;
  endTime: number;
}

export function runScenario(scenario: Scenario, opts: RunOptions): SimResult {
  const faults = opts.faults ?? NO_FAULTS;
  const world = new World(scenario, opts.seed, faults);
  for (const spec of scenario.devices) {
    const isRouter = spec.kind === 'router' || spec.kind === 'home-router';
    const dev: Device = isRouter ? new Router(world, spec) : spec.kind === 'vpn-server' ? new VpnServer(world, spec) : new Host(world, spec);
    if (dev instanceof Host && spec.tunnel) dev.tunnel = new TunnelClient(dev, spec.tunnel.ip, spec.tunnel.server);
    world.devices.set(spec.id, dev);
    for (const i of spec.ifaces) world.ifaceOwner.set(i.id, dev);
  }
  for (const spec of scenario.links) {
    const link = new Link(world, spec);
    world.links.set(spec.id, link);
    world.ifaceLink.set(spec.a, link);
    world.ifaceLink.set(spec.b, link);
  }
  // Servers listen from the start; the browser is started by the user (t = 0).
  for (const spec of scenario.devices) {
    const dev = world.devices.get(spec.id);
    if (!(dev instanceof Host)) continue;
    for (const app of spec.apps) {
      if (app.kind === 'dns-server') startDnsServer(dev, app);
      else if (app.kind === 'http-server') {
        startHttpServer(dev, app, scenario.tcp.serverMss);
        if (app.tls) startHttpsServer(dev, app.tls, app.processing, scenario.tcp.serverMss);
      }
    }
  }
  const starts = [{ device: scenario.startDevice, at: 0 }, ...(scenario.companion ? [scenario.companion] : [])];
  for (const s of starts) {
    const start = world.devices.get(s.device);
    const browser = start ? scenario.devices.find((d) => d.id === start.id)?.apps.find((a) => a.kind === 'browser') : undefined;
    if (start instanceof Host && browser?.kind === 'browser') {
      world.sim.at(s.at, () => startBrowser(start, browser, scenario.tcp.clientMss));
    }
  }
  world.sim.run(opts.maxTime ?? 600);
  return {
    scenario,
    seed: opts.seed,
    faults,
    events: world.sim.events,
    pdus: world.sim.pdus,
    packets: world.sim.packets,
    endTime: world.sim.now,
  };
}
