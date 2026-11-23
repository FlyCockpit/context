import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {};
vi.mock("@cockpit-context/env/shared", () => ({ env: envState }));

const sendMail = vi.fn();
const close = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, close }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

/** The verify connection: `connect` and `login` behave as each test sets. */
const smtp = vi.hoisted(() => ({
  instances: [] as Array<{ options: unknown; closed: boolean; loggedIn: unknown }>,
  connect: (callback: (error?: Error) => void) => callback(),
  login: (callback: (error?: Error) => void) => callback(),
  allowsAuth: true,
}));
vi.mock("nodemailer/lib/smtp-connection", () => ({
  default: class {
    state: { options: unknown; closed: boolean; loggedIn: unknown };
    constructor(options: unknown) {
      this.state = { options, closed: false, loggedIn: null };
      smtp.instances.push(this.state);
    }
    get allowsAuth() {
      return smtp.allowsAuth;
    }
    once() {
      return this;
    }
    connect(callback: (error?: Error) => void) {
      smtp.connect(callback);
    }
    login(auth: unknown, callback: (error?: Error) => void) {
      this.state.loggedIn = auth;
      smtp.login(callback);
    }
    close() {
      this.state.closed = true;
    }
  },
}));

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
      pool: true,
      maxConnections: 1,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    expect(sendMail).toHaveBeenCalledWith({ from: "App <no-reply@example.com>", ...message });
    // Its own transport, force-closed once the send is done.
    expect(close).toHaveBeenCalledExactlyOnceWith({ force: true });
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

  it("bounds the whole send: a relay that never answers fails at the deadline, without retries", async () => {
    sendMail.mockReturnValue(new Promise(() => {}));
    const { sendEmail, SEND_DEADLINE_MS, SmtpDeadlineError } = await loadMailer();
    const sent = sendEmail(message);
    const settled = expect(sent).rejects.toBeInstanceOf(SmtpDeadlineError);
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS - 1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(SEND_DEADLINE_MS).toBeLessThanOrEqual(60_000);
    // The cut-off attempt's connection is force-closed, even mid-delivery:
    // it cannot deliver late.
    expect(close).toHaveBeenCalledExactlyOnceWith({ force: true });
  });

  it("shares one budget across attempts: a slow failure leaves no time for a retry", async () => {
    const { sendEmail, SEND_DEADLINE_MS } = await loadMailer();
    // The first attempt fails transiently just before the deadline.
    sendMail.mockImplementationOnce(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(smtpError("Connection timeout")), SEND_DEADLINE_MS - 2_000),
        ),
    );
    const sent = sendEmail(message);
    const settled = expect(sent).rejects.toThrow("Connection timeout");
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS);
    await settled;
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("a later attempt only gets what is left of the budget", async () => {
    const { sendEmail, SEND_DEADLINE_MS, SmtpDeadlineError } = await loadMailer();
    sendMail
      .mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(smtpError("reset")), 10_000)),
      )
      .mockReturnValueOnce(new Promise(() => {}));
    const sent = sendEmail(message);
    const settled = expect(sent).rejects.toBeInstanceOf(SmtpDeadlineError);
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS);
    await settled;
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("queueEmail returns at once and only logs a failure", async () => {
    sendMail.mockRejectedValue(smtpError("550 no", 550));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { queueEmail } = await loadMailer();
    expect(queueEmail(message, "two-factor code")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[mailer] queued two-factor code email failed:",
      "Error: 550 no",
    );
    warn.mockRestore();
  });

  it("refuses to send without SMTP_FROM", async () => {
    delete envState.SMTP_FROM;
    const { sendEmail } = await loadMailer();
    await expect(sendEmail(message)).rejects.toThrow(/SMTP_FROM/);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("verifyTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    smtp.instances.length = 0;
    smtp.connect = (callback) => callback();
    smtp.login = (callback) => callback();
    smtp.allowsAuth = true;
    for (const key of Object.keys(envState)) delete envState[key];
    Object.assign(envState, {
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: 465,
      SMTP_USER: "mailer",
      SMTP_PASS: "inert-test-password",
      SMTP_FROM: "a@example.com",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects and authenticates on a connection of its own, then closes it", async () => {
    const { verifyTransport } = await loadMailer();
    await expect(verifyTransport()).resolves.toBe(true);
    expect(smtp.instances).toHaveLength(1);
    expect(smtp.instances[0]).toMatchObject({
      options: {
        host: "smtp.example.com",
        port: 465,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      },
      loggedIn: { user: "mailer", pass: "inert-test-password" },
      closed: true,
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("does not authenticate against a relay that offers no AUTH (as the pool would not)", async () => {
    smtp.allowsAuth = false;
    smtp.login = () => {
      throw new Error("must not log in");
    };
    const { verifyTransport } = await loadMailer();
    await expect(verifyTransport()).resolves.toBe(true);
    expect(smtp.instances[0]).toMatchObject({ loggedIn: null, closed: true });
  });

  it("answers false at its budget and closes that exact connection when the relay stalls", async () => {
    smtp.login = () => {};
    const { verifyTransport, VERIFY_DEADLINE_MS } = await loadMailer();
    const result = verifyTransport();
    await vi.advanceTimersByTimeAsync(VERIFY_DEADLINE_MS - 1);
    expect(smtp.instances[0]?.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(smtp.instances[0]?.closed).toBe(true);
  });

  it("answers false on a refused connection, and without SMTP opens nothing", async () => {
    smtp.connect = (callback) => callback(new Error("ECONNREFUSED"));
    const { verifyTransport } = await loadMailer();
    await expect(verifyTransport()).resolves.toBe(false);
    expect(smtp.instances[0]?.closed).toBe(true);
    delete envState.SMTP_HOST;
    smtp.instances.length = 0;
    await expect(verifyTransport()).resolves.toBe(false);
    expect(smtp.instances).toHaveLength(0);
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
