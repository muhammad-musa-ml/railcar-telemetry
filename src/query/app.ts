import Fastify, { type FastifyInstance } from "fastify";
import { Counter, Gauge, type Registry } from "prom-client";
import { CAR_ID_PATTERN } from "../shared/event";
import type { Logger } from "../shared/logger";
import { instrumentHttp } from "../shared/metrics";
import type { PositionReader } from "./positions";

export interface QueryDeps {
  positions: PositionReader;
  registry: Registry;
  logger?: Logger;
}

const MAX_LIMIT = 500;

export function buildQueryApp(deps: QueryDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  instrumentHttp(app, deps.registry);

  const freshnessErrors = new Counter({
    name: "railcar_positions_freshness_errors_total",
    help: "Scrapes where the freshness query against Postgres failed",
    registers: [deps.registry],
  });
  // How old the newest write to car_positions is. If the tracker stops
  // writing, this grows by one second every second. The label is there so
  // that reset() leaves no sample at all: an unlabelled gauge would report
  // 0 after a reset, which reads as "perfectly fresh" while Postgres is down.
  new Gauge({
    name: "railcar_positions_freshness_seconds",
    help: "Seconds since the tracker last updated any car position",
    labelNames: ["table"],
    registers: [deps.registry],
    async collect() {
      this.reset();
      try {
        const age = await deps.positions.freshnessSeconds();
        if (age !== null) {
          this.set({ table: "car_positions" }, age);
        }
      } catch {
        freshnessErrors.inc();
      }
    },
  });

  app.get<{ Params: { carId: string } }>("/v1/cars/:carId", async (request, reply) => {
    const { carId } = request.params;
    if (!CAR_ID_PATTERN.test(carId)) {
      return reply.code(400).send({ error: "car id must look like 'RCTX 104233'" });
    }
    try {
      const car = await deps.positions.getCar(carId);
      if (!car) {
        return reply.code(404).send({ error: "no reads for this car" });
      }
      return car;
    } catch (err) {
      deps.logger?.error({ err }, "position lookup failed");
      return reply.code(503).send({ error: "position store unavailable" });
    }
  });

  app.get<{ Params: { location: string }; Querystring: { limit?: string } }>(
    "/v1/locations/:location/cars",
    async (request, reply) => {
      const limit = Math.min(Number(request.query.limit ?? 100) || 100, MAX_LIMIT);
      try {
        // Longest dwell first: the cars that have sat the longest.
        const cars = await deps.positions.carsAt(request.params.location, limit);
        return { location: request.params.location, cars };
      } catch (err) {
        deps.logger?.error({ err }, "location lookup failed");
        return reply.code(503).send({ error: "position store unavailable" });
      }
    },
  );

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
