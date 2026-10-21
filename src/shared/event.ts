import { z } from "zod";

// One tag read from a trackside reader. North American railcars carry an
// RFID tag with the car's reporting mark and number; a reader at a yard or
// junction reports every tag that passes it. All data in this project is
// synthetic: the marks, readers and locations are made up.

// Reporting mark (2-4 letters) and car number, e.g. "RCTX 104233".
export const CAR_ID_PATTERN = /^[A-Z]{2,4} \d{1,6}$/;

export const locationEventSchema = z.object({
  event_id: z.uuid(),
  car_id: z.string().regex(CAR_ID_PATTERN, "car_id must look like 'RCTX 104233'"),
  reader_id: z.string().min(1).max(32),
  location: z.string().min(1).max(64),
  observed_at: z.iso.datetime({ offset: true }),
});

export type LocationEvent = z.infer<typeof locationEventSchema>;

export const MAX_BATCH = 500;

export const eventBatchSchema = z.object({
  events: z.array(locationEventSchema).min(1).max(MAX_BATCH),
});

export type EventBatch = z.infer<typeof eventBatchSchema>;
