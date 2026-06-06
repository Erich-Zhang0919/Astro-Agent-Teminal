import { greet } from "../src";

describe("greet", () => {
  it("returns a greeting for the provided name", () => {
    expect(greet("Astro")).toBe("Hello, Astro!");
  });
});
