import { Hono } from "hono";
import { html, raw } from "hono/html";
import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

/**
 * Minimal fixed-token auth (spec 17: "認証：最低限の固定トークン"). Opt-in — main()
 * only installs it when AUTH_TOKEN is set, so dev/tests run open. When enabled,
 * every request needs the token via `Authorization: Bearer`, the `pf_token`
 * cookie, or a `?token=` query (which then sets the cookie so the browser stays
 * logged in). Unauthenticated HTML GETs redirect to /login; everything else 401s.
 *
 * This is a shared-secret gate for a LAN/tailnet self-hosted box — not per-user
 * auth. Keep the token out of git (.env); serve only over the trusted network.
 */

const COOKIE = "pf_token";
const cookieOpts = { httpOnly: true, sameSite: "Lax", path: "/" } as const;

/** Constant-time token compare (node:crypto). Length still short-circuits —
 *  timingSafeEqual requires equal-length buffers; leaking the length is the
 *  standard accepted trade-off. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function presentedToken(c: Parameters<MiddlewareHandler>[0]): string | undefined {
  const auth = c.req.header("authorization");
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return getCookie(c, COOKIE);
}

export function createAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    // login + static assets stay open (so the login page can load its CSS).
    if (path === "/login" || path.startsWith("/vendor/")) return next();

    // ?token= grants access and remembers it in a cookie for later navigation.
    const q = c.req.query("token");
    if (q && safeEqual(q, token)) {
      setCookie(c, COOKIE, token, cookieOpts);
      return next();
    }
    const presented = presentedToken(c);
    if (presented && safeEqual(presented, token)) return next();

    const accept = c.req.header("accept") ?? "";
    if (c.req.method === "GET" && accept.includes("text/html")) return c.redirect("/login");
    return c.json({ error: "unauthorized" }, 401);
  };
}

function loginPage(error = false) {
  return html`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ログイン — Auto-swap</title>
  <link rel="stylesheet" href="/vendor/app.css" />
</head>
<body>
  <header class="topbar"><h1>Auto-swap</h1></header>
  <main>
    <form class="proj-new" method="post" action="/login" style="margin-top:24px">
      <input type="password" name="token" placeholder="アクセストークン" autofocus required />
      <button class="act primary" type="submit">ログイン</button>
    </form>
    ${error ? raw('<p class="muted" style="color:var(--red);padding:0 18px">トークンが違います</p>') : ""}
  </main>
</body>
</html>`;
}

/** /login routes (form + submit). Mount alongside createAuth. */
export function createLoginApp(token: string): Hono {
  const app = new Hono();
  app.get("/login", (c) => c.html(loginPage()));
  app.post("/login", async (c) => {
    const body = await c.req.parseBody();
    if (typeof body.token === "string" && safeEqual(body.token, token)) {
      setCookie(c, COOKIE, token, cookieOpts);
      return c.redirect("/");
    }
    return c.html(loginPage(true), 401);
  });
  return app;
}
