import { describe, expect, it } from "vitest";

import {
  ADMIN_PLUGIN_DENIED_PERMISSIONS,
  adminPluginAccess,
  cockpitContextAdminRole,
} from "./admin-access";

describe("admin plugin access control", () => {
  it.each(ADMIN_PLUGIN_DENIED_PERMISSIONS.user.map((action) => ["user", action] as const))(
    "denies %s:%s to admins",
    (resource, action) => {
      expect(cockpitContextAdminRole.authorize({ [resource]: [action] }).success).toBe(false);
    },
  );

  it.each(ADMIN_PLUGIN_DENIED_PERMISSIONS.session.map((action) => ["session", action] as const))(
    "denies %s:%s to admins",
    (resource, action) => {
      expect(cockpitContextAdminRole.authorize({ [resource]: [action] }).success).toBe(false);
    },
  );

  it("keeps the user management the app relies on", () => {
    expect(
      cockpitContextAdminRole.authorize({
        user: ["create", "list", "set-role", "ban", "delete", "get", "update"],
        session: ["revoke", "delete"],
      }).success,
    ).toBe(true);
  });

  it("gives the user role no admin-plugin permissions", () => {
    expect(adminPluginAccess.roles.user.authorize({ user: ["list"] }).success).toBe(false);
    expect(adminPluginAccess.roles.user.authorize({ user: ["impersonate"] }).success).toBe(false);
  });
});
