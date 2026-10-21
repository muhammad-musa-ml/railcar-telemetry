import { randomUUID } from "node:crypto";
import type { LocationEvent } from "../shared/event";

// A made-up fleet moving around a made-up network of yards. Each car sits at
// a yard for a random number of reads, then moves to the next yard.

export interface FleetOptions {
  cars: number;
  yards: number;
  seed: number;
}

interface CarState {
  carId: string;
  yard: number;
  readsLeft: number;
}

// Small deterministic PRNG so a given seed always produces the same fleet.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function yardCode(index: number): string {
  return `YD${String(index + 1).padStart(2, "0")}`;
}

export function carId(index: number): string {
  return `RCTX ${String(100000 + index)}`;
}

export class Fleet {
  private readonly cars: CarState[];
  private readonly random: () => number;

  constructor(private readonly options: FleetOptions) {
    this.random = mulberry32(options.seed);
    this.cars = Array.from({ length: options.cars }, (_, i) => ({
      carId: carId(i),
      yard: Math.floor(this.random() * options.yards),
      readsLeft: this.readsAtYard(),
    }));
  }

  private readsAtYard(): number {
    return 3 + Math.floor(this.random() * 28);
  }

  randomCarId(): string {
    return this.cars[Math.floor(this.random() * this.cars.length)]!.carId;
  }

  // The next n tag reads, each for a randomly chosen car.
  nextReads(n: number, now: Date): LocationEvent[] {
    const events: LocationEvent[] = [];
    for (let i = 0; i < n; i++) {
      const car = this.cars[Math.floor(this.random() * this.cars.length)]!;
      if (car.readsLeft === 0) {
        car.yard = (car.yard + 1) % this.options.yards;
        car.readsLeft = this.readsAtYard();
      }
      car.readsLeft -= 1;
      const yard = yardCode(car.yard);
      events.push({
        event_id: randomUUID(),
        car_id: car.carId,
        reader_id: `AEI-${yard}-${this.random() < 0.5 ? "E" : "W"}`,
        location: yard,
        observed_at: now.toISOString(),
      });
    }
    return events;
  }
}
