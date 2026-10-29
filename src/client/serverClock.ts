import type { ClockReply } from "../shared/protocol";

type Sample = { received: number; server: number; roundTrip: number };

export class ServerClock {
  private samples: Sample[] = [];
  private anchor: Sample | null = null;
  constructor(private monotonic = () => performance.now(), private wall = () => Date.now()) {}

  now(): number {
    return this.anchor ? this.anchor.server + Math.max(0, this.monotonic() - this.anchor.received) : this.wall();
  }

  sample(sent: number, reply: ClockReply): boolean {
    const received = this.monotonic();
    const roundTrip = received - sent;
    if (!reply.ok || !Number.isSafeInteger(reply.serverReceivedAt) || !Number.isSafeInteger(reply.serverSentAt) ||
      reply.serverReceivedAt < 0 || reply.serverSentAt < reply.serverReceivedAt || roundTrip < 0 || roundTrip > 10_000) return false;
    const networkTime = Math.max(0, roundTrip - (reply.serverSentAt - reply.serverReceivedAt));
    const sample = { received, server: reply.serverSentAt + networkTime / 2, roundTrip: networkTime };
    this.samples = [...this.samples.filter(value => received - value.received < 60_000), sample].slice(-8);
    this.anchor = this.samples.reduce((best, value) => value.roundTrip < best.roundTrip ? value : best);
    return true;
  }

  reset(): void { this.samples = []; this.anchor = null; }
  forgetSamples(): void { this.samples = []; }
}

export const serverClock = new ServerClock();
