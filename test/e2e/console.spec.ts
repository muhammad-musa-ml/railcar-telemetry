import { expect, test } from "@playwright/test";
import { consoleOperator, read, redisCli, testCarId } from "../integration/helpers";

test("opens the overview, goes to the dead letters and replays an event", async ({ page }) => {
  // A valid event parked in the dead-letter stream, as the runbook's manual step does.
  const carId = testCarId();
  const event = JSON.stringify(read(carId, "YD03", new Date()));
  const [id] = await redisCli("XADD", "railcar:events:dead", "*", "source_id", "0-1", "reason", "manual", "event", event);
  expect(id).toMatch(/^\d+-\d+$/);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Railcar console" })).toBeVisible();
  await expect(page.locator(".tile", { hasText: "tracker" })).toContainText("up");
  await expect(page.getByRole("rowheader", { name: "Dead-lettered events" })).toBeVisible();

  await page.getByLabel("Operator token").fill(consoleOperator.token);
  await page.getByRole("link", { name: "Review dead letters" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Dead letters" })).toBeFocused();

  await page.getByRole("button", { name: `Replay ${id}...` }).click();
  await page.getByLabel("Reason (optional)").fill("replayed from the browser test");
  await page.getByRole("button", { name: "Confirm replay" }).click();
  await expect(page.getByRole("status")).toContainText(`Replayed ${id}. It is back in railcar:events`);
  await expect(page.getByRole("button", { name: `Replay ${id}...` })).toHaveCount(0);

  // The tracker writes the replayed read, and the lookup view finds the car there.
  await page.getByRole("link", { name: "Car and location lookup" }).click();
  await page.getByLabel("Car id").fill(carId);
  await page.getByRole("button", { name: "Find car" }).click();
  await expect(page.getByLabel(`Position of ${carId}`)).toContainText("YD03", { timeout: 30_000 });
});
