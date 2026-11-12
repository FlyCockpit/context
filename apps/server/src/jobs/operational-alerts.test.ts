import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
const isEmailConfigured = vi.fn(() => true);

vi.mock("@cockpit-context/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
// The real mailer module is loaded for `escapeHtml`; keep it off the env validation.
vi.mock("@cockpit-context/env/shared", () => ({ env: {} }));
vi.mock("@cockpit-context/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cockpit-context/mailer")>();
  return {
    ...actual,
    isEmailConfigured: () => isEmailConfigured(),
    sendEmail: (args: unknown) => sendEmail(args),
  };
});

const { default: prisma } = await import("@cockpit-context/db");
const {
  resetOperationalAlertCooldowns,
  sendDataDeletedAlert,
  sendJobFailureAlert,
  sendOperationalAlert,
  sendSummaryRunFailureAlert,
} = await import("./operational-alerts.js");

const db = prisma as unknown as { user: { findMany: ReturnType<typeof vi.fn> } };

const alert = {
  source: "repo.fetch",
  message: "boom",
  subject: "[repo.fetch] background job failed",
  html: "<p>boom</p>",
};

describe("sendOperationalAlert", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetOperationalAlertCooldowns();
    isEmailConfigured.mockReturnValue(true);
    db.user.findMany.mockResolvedValue([
      { id: "u1", email: "admin@example.com", role: "admin", locale: "en-US" },
      { id: "u2", email: "member@example.com", role: "user" },
    ]);
  });
  afterEach(() => vi.useRealTimers());

  it("emails only admins who opted in", async () => {
    await expect(sendOperationalAlert(alert)).resolves.toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com", subject: alert.subject }),
    );
    expect(db.user.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      emailVerified: true,
      operationalAlerts: true,
    });
  });

  it("releases the reservation when all sends fail, or nobody is an admin", async () => {
    sendEmail.mockRejectedValue(new Error("SMTP down"));
    await expect(sendOperationalAlert(alert)).resolves.toBe(0);
    sendEmail.mockResolvedValue(undefined);
    await expect(sendOperationalAlert(alert)).resolves.toBe(1);
    resetOperationalAlertCooldowns();
    db.user.findMany.mockResolvedValue([]);
    await expect(sendOperationalAlert(alert)).resolves.toBe(0);
    db.user.findMany.mockResolvedValue([
      { id: "u1", email: "admin@example.com", role: "user, admin", locale: "es-MX" },
    ]);
    await expect(sendOperationalAlert(alert)).resolves.toBe(1);
  });

  it("releases the reservation when the recipient lookup fails", async () => {
    db.user.findMany.mockRejectedValueOnce(new Error("DB down"));
    await expect(sendOperationalAlert(alert)).rejects.toThrow("DB down");
    await expect(sendOperationalAlert(alert)).resolves.toBe(1);
  });

  it("keeps the cooldown after partial delivery and returns the successful count", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "a", email: "a@example.com", role: "admin" },
      { id: "b", email: "b@example.com", role: "admin" },
    ]);
    sendEmail.mockRejectedValueOnce(new Error("rejected")).mockResolvedValue(undefined);
    await expect(sendOperationalAlert(alert)).resolves.toBe(1);
    await expect(sendOperationalAlert(alert)).resolves.toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("uses bounded keyset pages", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`,
      email: `u${i}@example.com`,
      role: "admin",
    }));
    db.user.findMany.mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    await expect(sendOperationalAlert(alert)).resolves.toBe(50);
    expect(db.user.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        take: 50,
        where: expect.objectContaining({ id: { gt: "u49" } }),
        select: { id: true, email: true, role: true, locale: true },
      }),
    );
  });

  it("blocks overlapping sends even if the cooldown expires while sending", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    sendEmail.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = sendOperationalAlert(alert);
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(3600_001);
    await expect(sendOperationalAlert(alert)).resolves.toBe(0);
    finish?.();
    await expect(first).resolves.toBe(1);
  });

  it("renders deletion notices and failures in each recipient's locale", async () => {
    db.user.findMany.mockResolvedValue([
      { id: "a", email: "en@example.com", role: "admin", locale: "en-US" },
      { id: "b", email: "es@example.com", role: "admin", locale: "es-MX" },
    ]);
    const notice = {
      name: "20260101_remove",
      effects: "<data>",
      deletedAt: new Date("2026-01-01Z"),
      backup: "backup.dump",
      note: null,
    };
    await expect(sendDataDeletedAlert(notice)).resolves.toBe(2);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "es@example.com",
        subject: "Se completó la eliminación programada de datos",
        html: expect.stringContaining("&lt;data&gt;"),
      }),
    );
    await sendJobFailureAlert({ type: "x", id: "job", attempts: 1, error: "fail" });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "es@example.com",
        subject: "[x] falló una tarea en segundo plano",
      }),
    );
    await expect(sendDataDeletedAlert({ ...notice, name: "20260202_remove" })).resolves.toBe(2);
  });

  it("retries unmarked notices after a restart forgets successful-send cooldowns", async () => {
    const notice = {
      name: "20260101_remove",
      effects: null,
      deletedAt: new Date("2026-01-01Z"),
      backup: null,
      note: null,
    };
    await expect(sendDataDeletedAlert(notice)).resolves.toBe(1);
    await expect(sendDataDeletedAlert(notice)).resolves.toBe(0);
    resetOperationalAlertCooldowns();
    await expect(sendDataDeletedAlert(notice)).resolves.toBe(1);
  });

  it("is a no-op without SMTP", async () => {
    isEmailConfigured.mockReturnValue(false);
    await sendOperationalAlert(alert);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it("sends one email per fingerprint per cooldown window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
    await sendOperationalAlert(alert);
    // Same failure with a different number in it shares the fingerprint.
    await sendOperationalAlert({ ...alert, message: "boom" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // A different failure is a different fingerprint.
    await sendOperationalAlert({ ...alert, message: "another failure" });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-24T01:00:01Z"));
    await sendOperationalAlert(alert);
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it("masks ids and numbers when fingerprinting", async () => {
    await sendOperationalAlert({ ...alert, message: "timeout after 3000 ms" });
    await sendOperationalAlert({ ...alert, message: "timeout after 5000 ms" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("escapes job details in the failure email", async () => {
    await sendJobFailureAlert({
      type: "repo.fetch",
      id: "j1",
      attempts: 3,
      error: `<script>"it's" & more`,
    });
    const html = sendEmail.mock.calls[0]?.[0]?.html as string;
    expect(html).toContain("&lt;script&gt;&quot;it&#39;s&quot; &amp; more");
    expect(html).not.toContain("<script>");
  });

  it("names the run and checkout of a failed summary and shares the job alert's cooldown", async () => {
    await sendSummaryRunFailureAlert({
      jobType: "checkout.summarize",
      runId: "run-1",
      checkoutId: "<k1>",
      error: "model down",
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const email = sendEmail.mock.calls[0]?.[0] as { subject: string; html: string } | undefined;
    const subject = email?.subject;
    const html = email?.html ?? "";
    expect(subject).toBe("[checkout.summarize] checkout summary run failed");
    expect(html).toContain("summary run failed");
    expect(html).toContain("<dt>Run</dt><dd>run-1</dd>");
    expect(html).toContain("&lt;k1&gt;");
    expect(html).not.toContain("background job failed");
    // The same failure reported as a job is inside the same cooldown window.
    await sendJobFailureAlert({
      type: "checkout.summarize",
      id: "j1",
      attempts: 1,
      error: "model down",
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
