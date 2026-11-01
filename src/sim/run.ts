import type { PacketInfo, PduSnapshot } from './core/Simulator';
import type { SimEvent } from './events/SimEvent';
import { NO_FAULTS, type FaultPlan } from './faults';
import type { Scenario } from './model';
import { startBrowser, startDnsAuthority, startDnsServer, startFlood, startHttpServer, startMqttBroker, startMqttClient, startPing, startPortScan, startTcpService, startTraceroute, startVoiceCall, startVoicePeer } from './stack/apps';
import { startDhcpClient } from './stack/dhcp';
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
  // Servers listen from the start; the browser (or ping, or traceroute) is started by the user (t = 0), after DHCP if the
  // device needs an address first.
  for (const spec of scenario.devices) {
    const dev = world.devices.get(spec.id);
    if (!(dev instanceof Host)) continue;
    for (const app of spec.apps) {
      if (app.kind === 'dns-server') startDnsServer(dev, app);
      else if (app.kind === 'dns-authority') startDnsAuthority(dev, app);
      else if (app.kind === 'http-server') {
        startHttpServer(dev, app, scenario.tcp.serverMss);
        if (app.tls) startHttpsServer(dev, app.tls, app.processing, scenario.tcp.serverMss);
      } else if (app.kind === 'voice-peer') startVoicePeer(dev, app);
      else if (app.kind === 'tcp-service') startTcpService(dev, app.port, scenario.tcp.serverMss);
      else if (app.kind === 'mqtt-broker') startMqttBroker(dev, app, scenario.tcp.serverMss);
    }
  }
  // The user starts the browser, a voice call, a ping or a traceroute at t = 0; after DHCP if the device needs an address first.
  const starts = [{ device: scenario.startDevice, at: 0 }, ...(scenario.attackers ?? []), ...(scenario.companions ?? [])];
  for (const [job, s] of starts.entries()) {
    const start = world.devices.get(s.device);
    const apps = start ? (scenario.devices.find((d) => d.id === start.id)?.apps ?? []) : [];
    const browser = apps.find((a) => a.kind === 'browser');
    const call = apps.find((a) => a.kind === 'voice-call');
    const probe = apps.find((a) => a.kind === 'ping' || a.kind === 'traceroute');
    const dhcp = apps.find((a) => a.kind === 'dhcp-client');
    const flood = apps.find((a) => a.kind === 'flood');
    const scan = apps.find((a) => a.kind === 'port-scan');
    const mqtt = apps.find((a) => a.kind === 'mqtt-client');
    if (!(start instanceof Host)) continue;
    const open = (resolver?: string): void => {
      if (call?.kind === 'voice-call') startVoiceCall(start, call, resolver);
      else if (probe?.kind === 'ping') startPing(start, probe, resolver);
      else if (probe?.kind === 'traceroute') startTraceroute(start, probe, resolver);
      else if (browser?.kind === 'browser') startBrowser(start, browser, scenario.tcp.clientMss, resolver);
    };
    world.sim.job = job;
    if (flood?.kind === 'flood') world.sim.at(s.at, () => startFlood(start, flood));
    if (scan?.kind === 'port-scan') world.sim.at(s.at, () => startPortScan(start, scan));
    if (mqtt?.kind === 'mqtt-client') world.sim.at(s.at, () => startMqttClient(start, mqtt, scenario.tcp.clientMss));
    if (call || probe || browser) world.sim.at(s.at, () => (dhcp?.kind === 'dhcp-client' ? startDhcpClient(start, dhcp, (lease) => open(lease.dns[0])) : open()));
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
