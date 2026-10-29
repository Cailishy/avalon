import { describe, expect, it } from "vitest";
import { ServerClock } from "./serverClock";

describe("Server-relative monotonic time", () => {
  it("accepts a fresh resume estimate even if an older sample had a lower RTT", () => {
    let mono = 100;
    const clock = new ServerClock(() => mono);
    clock.sample(99, { ok: true, protocolVersion: 2, serverReceivedAt: 1000, serverSentAt: 1000 });
    clock.forgetSamples(); mono = 200;
    clock.sample(180, { ok: true, protocolVersion: 2, serverReceivedAt: 3601000, serverSentAt: 3601000 });
    expect(clock.now()).toBe(3601010);
  });
  it("uses round-trip compensation and ignores later wall-clock jumps", () => {
    let mono = 200; let wall = 99999999;
    const clock = new ServerClock(() => mono, () => wall);
    expect(clock.now()).toBe(wall);
    expect(clock.sample(0, { ok: true, protocolVersion: 2, serverReceivedAt: 50050, serverSentAt: 50060 })).toBe(true);
    expect(clock.now()).toBe(50155);
    mono += 1000; wall -= 8 * 3600000;
    expect(clock.now()).toBe(51155);
  });
  it("prefers low-latency samples but ages out stale estimates", () => {
    let mono = 100;
    const clock = new ServerClock(() => mono);
    clock.sample(90, { ok: true, protocolVersion: 2, serverReceivedAt: 1000, serverSentAt: 1000 });
    mono = 2000;
    clock.sample(100, { ok: true, protocolVersion: 2, serverReceivedAt: 10000, serverSentAt: 10000 });
    expect(clock.now()).toBe(2905);
    mono = 62000;
    clock.sample(61980, { ok: true, protocolVersion: 2, serverReceivedAt: 50000, serverSentAt: 50000 });
    expect(clock.now()).toBe(50010);
  });
  it("rejects malformed or excessively late samples without losing a good anchor", () => {
    let mono = 0;
    const clock = new ServerClock(() => mono);
    clock.sample(0, { ok: true, protocolVersion: 2, serverReceivedAt: 1000, serverSentAt: 1000 });
    expect(clock.sample(0, { ok: true, protocolVersion: 2, serverReceivedAt: 1000, serverSentAt: NaN })).toBe(false);
    mono = 11000;
    expect(clock.sample(0, { ok: true, protocolVersion: 2, serverReceivedAt: 10000, serverSentAt: 10000 })).toBe(false);
    expect(clock.now()).toBe(12000);
  });
});
