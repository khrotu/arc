import { describe, it, expect } from "vitest";
import { pickLogo } from "../src/branding/branding";
describe("pickLogo", () => {
  it("returns 'mono' in January", () => {
    const d = new Date(Date.UTC(2026, 0, 15, 12)); 
    expect(pickLogo("june", d).kind).toBe("mono");
    expect(pickLogo("june", d).file).toBe("arc-logo-mono.svg");
  });
  it("returns 'mono' in May", () => {
    expect(pickLogo("june", new Date(Date.UTC(2026, 4, 31, 23, 59))).kind).toBe("mono");
  });
  it("returns 'pride' on June 1 (UTC midnight)", () => {
    const d = new Date(Date.UTC(2026, 5, 1, 0, 0));
    expect(pickLogo("june", d).kind).toBe("pride");
    expect(pickLogo("june", d).file).toBe("arc-logo-pride.svg");
  });
  it("returns 'pride' on June 30 (UTC end of day)", () => {
    expect(pickLogo("june", new Date(Date.UTC(2026, 5, 30, 23, 59))).kind).toBe("pride");
  });
  it("returns 'mono' on July 1 (UTC midnight)", () => {
    expect(pickLogo("june", new Date(Date.UTC(2026, 6, 1, 0, 0))).kind).toBe("mono");
  });
  it("returns 'mono' in December", () => {
    expect(pickLogo("june", new Date(Date.UTC(2026, 11, 25))).kind).toBe("mono");
  });
  it("uses UTC month (not local)", () => {
    const d = new Date(Date.UTC(2026, 5, 30, 23, 30));
    expect(pickLogo("june", d).kind).toBe("pride");
  });
  it("alt text is always 'Arc'", () => {
    expect(pickLogo("june", new Date(Date.UTC(2026, 5, 1))).alt).toBe("Arc");
    expect(pickLogo("june", new Date(Date.UTC(2026, 0, 1))).alt).toBe("Arc");
  });
});