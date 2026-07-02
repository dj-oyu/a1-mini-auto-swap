import { describe, expect, test } from "bun:test";
import { REDACTED, redactFields } from "../../src/obs/redact.ts";

describe("redactFields", () => {
  test("each secret key is redacted (case-insensitive substring match)", () => {
    const out = redactFields({
      accessCode: "12345678",
      access_code: "87654321",
      PRINTER_ACCESS_CODE: "abcd",
      password: "hunter2",
      passwd: "hunter2",
      authToken: "eyJhbGc",
      token: "sk-secret",
      discordWebhookUrl: "https://discord.com/api/webhooks/xxx/yyy",
      Authorization: "Bearer zzz",
      apiKey: "ak-1",
      api_key: "ak-2",
      dbCredential: "pw",
      clientSecret: "shh",
    });
    for (const v of Object.values(out)) {
      expect(v).toBe(REDACTED);
    }
  });

  test("non-secret fields are preserved verbatim", () => {
    const out = redactFields({
      jobId: 12,
      filename: "plate_03.gcode.3mf",
      percent: 42,
      ok: true,
      nothing: null,
    });
    expect(out).toEqual({
      jobId: 12,
      filename: "plate_03.gcode.3mf",
      percent: 42,
      ok: true,
      nothing: null,
    });
  });

  test("redacts secrets nested in objects and arrays", () => {
    const out = redactFields({
      user: "bob",
      printer: { host: "controller", accessCode: "secret", port: 990 },
      creds: [{ token: "a" }, { token: "b", note: "keep" }],
    });
    expect(out).toEqual({
      user: "bob",
      printer: { host: "controller", accessCode: REDACTED, port: 990 },
      creds: [{ token: REDACTED }, { token: REDACTED, note: "keep" }],
    });
  });

  test("does not mutate the input object", () => {
    const input = { accessCode: "secret", keep: 1 };
    const out = redactFields(input);
    expect(input.accessCode).toBe("secret");
    expect(out.accessCode).toBe(REDACTED);
  });

  test("Uint8Array is summarized, not walked as secret indices", () => {
    const out = redactFields({ blob: new Uint8Array([1, 2, 3, 4]) });
    expect(out.blob).toBe("<4 bytes>");
  });

  test("guards against cycles", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = redactFields({ a });
    expect((out.a as Record<string, unknown>).name).toBe("a");
    expect((out.a as Record<string, unknown>).self).toBe("[Circular]");
  });
});
