import net from "node:net";

import { afterAll } from "vitest";

const testIoGuardKey = Symbol.for("cockpit-context.test-io-guard");

type TestIoGuardState = {
  active: true;
  connectionAttempts: number;
};

const existingState = Reflect.get(globalThis, testIoGuardKey);
const state: TestIoGuardState =
  typeof existingState === "object" &&
  existingState !== null &&
  Reflect.get(existingState, "active") === true &&
  typeof Reflect.get(existingState, "connectionAttempts") === "number"
    ? (existingState as TestIoGuardState)
    : { active: true, connectionAttempts: 0 };

if (existingState === undefined) {
  Object.defineProperty(globalThis, testIoGuardKey, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });

  const guardedConnect = function testIoGuardedSocketConnect() {
    state.connectionAttempts += 1;
    throw new Error("Test I/O guard blocked a TCP socket connection.");
  };
  Object.defineProperty(guardedConnect, testIoGuardKey, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  Object.defineProperty(net.Socket.prototype, "connect", {
    configurable: false,
    enumerable: false,
    value: guardedConnect,
    writable: false,
  });
}

// Some clients (database pools, SMTP) can open a TCP connection at import time.
// This direct prototype replacement blocks that connection before a socket
// exists, including when a dependency was externalized past Vitest's module
// mocks. It is deliberately not a general network or subprocess sandbox.
// `vi.restoreAllMocks()` cannot restore this non-Vitest replacement.
afterAll(() => {
  if (state.connectionAttempts !== 0) {
    throw new Error(
      `Test I/O guard blocked ${state.connectionAttempts} TCP connection attempt(s); mock the import boundary.`,
    );
  }
});
