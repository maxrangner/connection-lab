export function fmtTime(s: number): string {
  const a = Math.abs(s);
  if (a === 0) return '0 s';
  if (a < 1e-6) return `${(s * 1e9).toFixed(0)} ns`;
  if (a < 1e-3) return `${(s * 1e6).toFixed(a < 1e-5 ? 2 : 1)} µs`;
  if (a < 1) return `${(s * 1e3).toFixed(a < 0.01 ? 3 : 2)} ms`;
  return `${s.toFixed(2)} s`;
}

export function fmtRate(bps: number): string {
  if (bps >= 1e9) return `${bps / 1e9} Gbit/s`;
  if (bps >= 1e6) return `${bps / 1e6} Mbit/s`;
  return `${bps / 1e3} kbit/s`;
}
