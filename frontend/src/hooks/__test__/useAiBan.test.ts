import { describe, expect, it, vi } from "vitest";

vi.mock("@/stores/useAppStateStore", () => ({ useAppStateStore: () => ({ state: {} }) }));
vi.mock("axios", () => ({ default: {} }));

import { banFormProblem } from "../useAiBan";

const form = {
  player: "Griefer",
  reason: "Griefing de la base de Bob avec de la TNT",
  description: "",
  logLines: ["[12:00] Griefer issued server command: /fill"],
  images: []
};

describe("banFormProblem", () => {
  it("accepts a complete request", () => {
    expect(banFormProblem(form)).toBe("");
  });

  it("flags invalid player names, short reasons and missing evidence", () => {
    expect(banFormProblem({ ...form, player: "a b" })).toBe("player");
    expect(banFormProblem({ ...form, reason: "trop court" })).toBe("reason");
    expect(banFormProblem({ ...form, logLines: [] })).toBe("evidence");
    expect(banFormProblem({ ...form, logLines: [], description: "x".repeat(30) })).toBe("");
    expect(banFormProblem({ ...form, logLines: [], images: ["data:image/png;base64,AA"] })).toBe("");
  });
});
