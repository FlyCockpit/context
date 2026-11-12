import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {};
vi.mock("@cockpit-context/env/shared", () => ({ env: envState }));

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

/** A fresh module per test: the transport is cached at module scope. */
async function loadMailer() {
  vi.resetModules();
  return import("./index");
}

function smtpError(message: string, responseCode?: number): Error {
  return Object.assign(new Error(message), responseCode ? { responseCode } : {});
}

const message = { to: "user@example.com", subject: "Hi", html: "<p>Hi</p>" };

describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    sendMail.mockReset();
    for (const key of Object.keys(envState)) delete envState[key];
    Object.assign(envState, {
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: 2525,
      SMTP_USER: "mailer",
      SMTP_PASS: "inert-test-password",
      SMTP_FROM: "App <no-reply@example.com>",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the transport with bounded connection, greeting and socket timeouts", async () => {
    sendMail.mockResolvedValue({});
    const { sendEmail } = await loadMailer();
    await sendEmail(message);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 2525,
      auth: { user: "mailer", pass: "inert-test-password" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    expect(sendMail).toHaveBeenCalledWith({ from: "App <no-reply@example.com>", ...message });
  });

  it("retries transient failures (4xx replies, network errors) up to three attempts", async () => {
    sendMail
      .mockRejectedValueOnce(smtpError("451 try again later", 451))
      .mockRejectedValueOnce(smtpError("Connection timeout"))
      .mockResolvedValueOnce({});
    const { sendEmail } = await loadMailer();
    const sent = sendEmail(message);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(sent).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it("gives up after three transient failures and throws the last error", async () => {
    sendMail.mockRejectedValue(smtpError("421 service not available", 421));
    const { sendEmail } = await loadMailer();
    const sent = sendEmail(message);
    const settled = expect(sent).rejects.toThrow("421 service not available");
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it("does not retry a permanent 5xx rejection", async () => {
    const rejection = smtpError("550 mailbox unavailable", 550);
    sendMail.mockRejectedValue(rejection);
    const { sendEmail } = await loadMailer();
    await expect(sendEmail(message)).rejects.toBe(rejection);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("refuses to send without SMTP_FROM", async () => {
    delete envState.SMTP_FROM;
    const { sendEmail } = await loadMailer();
    await expect(sendEmail(message)).rejects.toThrow(/SMTP_FROM/);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("escapeHtml", () => {
  it("escapes every HTML-significant character, including single quotes", async () => {
    const { escapeHtml } = await loadMailer();
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
});
