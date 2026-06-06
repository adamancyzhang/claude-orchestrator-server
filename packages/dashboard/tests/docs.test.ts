// CORE-RETENTION
// Locks in: API documentation — endpoint listing, HTML generation.
// Critical because: Docs help developers understand the API.
// Broken docs provide wrong information about endpoints.
// Primary sources: packages/dashboard/src/docs.ts

import { describe, expect, it } from "vitest";
import { getApiDocs, generateDocsHtml } from "../src/docs.js";

describe("getApiDocs", () => {
  it("returns array of endpoints", () => {
    const docs = getApiDocs();
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThan(0);
  });

  it("each endpoint has required fields", () => {
    const docs = getApiDocs();
    for (const ep of docs) {
      expect(ep).toHaveProperty("method");
      expect(ep).toHaveProperty("path");
      expect(ep).toHaveProperty("description");
      expect(ep).toHaveProperty("response");
      expect(ep).toHaveProperty("auth");
      expect(["GET", "POST", "PUT", "DELETE"]).toContain(ep.method);
      expect(ep.path).toMatch(/^\/api\//);
    }
  });

  it("includes all required endpoints", () => {
    const docs = getApiDocs();
    const paths = docs.map((ep) => ep.path);
    expect(paths).toContain("/api/state");
    expect(paths).toContain("/api/workers");
    expect(paths).toContain("/api/tasks");
    expect(paths).toContain("/api/events");
    expect(paths).toContain("/api/chains");
    expect(paths).toContain("/api/send");
    expect(paths).toContain("/api/events/stream");
    expect(paths).toContain("/api/docs");
    expect(paths).toContain("/api/health");
  });

  it("send endpoint requires auth", () => {
    const docs = getApiDocs();
    const sendEndpoint = docs.find((ep) => ep.path === "/api/send");
    expect(sendEndpoint?.auth).toBe(true);
  });

  it("read endpoints do not require auth", () => {
    const docs = getApiDocs();
    const readEndpoints = docs.filter((ep) => ep.method === "GET" && ep.path !== "/api/send");
    for (const ep of readEndpoints) {
      expect(ep.auth).toBe(false);
    }
  });
});

describe("generateDocsHtml", () => {
  it("returns valid HTML", () => {
    const html = generateDocsHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("contains endpoint table", () => {
    const html = generateDocsHtml();
    expect(html).toContain("<table>");
    expect(html).toContain("GET");
    expect(html).toContain("POST");
    expect(html).toContain("/api/state");
    expect(html).toContain("/api/send");
  });

  it("contains authentication section", () => {
    const html = generateDocsHtml();
    expect(html).toContain("Authentication");
    expect(html).toContain("Authorization");
  });

  it("contains error responses section", () => {
    const html = generateDocsHtml();
    expect(html).toContain("Error Responses");
    expect(html).toContain("400");
    expect(html).toContain("401");
    expect(html).toContain("429");
  });
});
