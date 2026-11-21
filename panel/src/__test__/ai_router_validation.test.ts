import { describe, expect, it, vi } from "vitest";
import validator from "../app/middleware/validator";

// The AI conversation route validates `{ title: String }`; the validator rejects empty strings,
// so clients must always send a non-empty title (the panel renames instance conversations).
describe("AI conversation creation payload", () => {
  const run = async (body: Record<string, unknown>) => {
    const next = vi.fn();
    const ctx: any = { request: { body }, params: {}, query: {} };
    await validator({ body: { title: String } })(ctx, next);
    return { ctx, next };
  };

  it("accepts the instance-bound payload sent by the frontend", async () => {
    const { next } = await run({
      title: "New conversation",
      daemonId: "daemon-1",
      instanceUuid: "instance-1"
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects an empty title", async () => {
    const { ctx, next } = await run({ title: "", daemonId: "daemon-1", instanceUuid: "i" });
    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(400);
  });
});
