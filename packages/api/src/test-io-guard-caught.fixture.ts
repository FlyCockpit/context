import net from "node:net";

import { describe, expect, it } from "vitest";

const testIoGuardKey = Symbol.for("cockpit-context.test-io-guard");

describe("test I/O guard caught-attempt fixture", () => {
  it("catches only the verified guard replacement", () => {
    const guardedConnect = net.Socket.prototype.connect;

    // Do not call a native connect function if setup/configuration is absent.
    expect(Reflect.get(guardedConnect, testIoGuardKey)).toBe(true);
    expect(() => Reflect.apply(guardedConnect, {}, [])).toThrow("Test I/O guard blocked a TCP");
  });
});
