import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAuth, createLoginApp } from "../../src/api/auth.ts";

const TOKEN = "s3cret-token";

let app: Hono;

beforeEach(() => {
  app = new Hono();
  app.use("*", createAuth(TOKEN));
  app.route("/", createLoginApp(TOKEN));
  app.get("/", (c) => c.html("<!doctype html><h1>dash</h1>"));
  app.get("/api/queue", (c) => c.json({ jobs: [] }));
  app.get("/vendor/app.css", (c) => c.text("body{}"));
});

const htmlGet = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { accept: "text/html", ...headers } });

describe("createAuth (fixed-token gate)", () => {
  test("API without a token → 401", async () => {
    const res = await app.request("/api/queue");
    expect(res.status).toBe(401);
  });

  test("HTML GET without a token → redirect to /login", async () => {
    const res = await htmlGet("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("accepts a valid Bearer token", async () => {
    const res = await app.request("/api/queue", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  test("rejects a wrong Bearer token → 401", async () => {
    const res = await app.request("/api/queue", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  test("?token= grants access and sets the cookie", async () => {
    const res = await htmlGet(`/?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("pf_token=");
  });

  test("a valid cookie authenticates subsequent requests", async () => {
    const res = await app.request("/api/queue", { headers: { cookie: `pf_token=${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  test("/login and /vendor/* stay open without a token", async () => {
    expect((await htmlGet("/login")).status).toBe(200);
    expect((await app.request("/vendor/app.css")).status).toBe(200);
  });
});

describe("createLoginApp", () => {
  test("GET /login serves the form", async () => {
    const res = await htmlGet("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="token"');
  });

  test("POST /login with the right token sets the cookie and redirects home", async () => {
    const res = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${TOKEN}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("pf_token=");
  });

  test("POST /login with a wrong token → 401, no cookie", async () => {
    const res = await app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=wrong",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
