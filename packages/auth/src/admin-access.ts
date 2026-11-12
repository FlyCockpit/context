import { defaultAc, userAc } from "better-auth/plugins/admin/access";

// Permissions for Better-Auth's admin plugin (`/api/auth/admin/*`).
//
// docs/access-matrix.md: admins **cannot** read other users' packages,
// conversations, keys or tokens. The plugin's default admin role contradicts
// that: `impersonate` mints a session as any user, and `set-password` /
// `set-email` let an admin take an account over and then sign in as it.
// `set-phone` (better-auth 1.7.16) gates writing `phoneNumber` /
// `phoneNumberVerified` through `admin/update-user`, the same takeover shape.
// `session:list` returns another user's session rows. None of these are used
// by Cockpit Context — user management goes through the `users.*` oRPC procedures, and
// the only plugin endpoint the app calls is `auth.api.createUser` (server
// side, `users.invite`). So the admin role keeps everything except those.
//
// Adding any of them back is an access-matrix change: update docs/access-matrix.md and the
// privacy notice (`privacy:sections.access`) in the same change.
export const ADMIN_PLUGIN_DENIED_PERMISSIONS = {
  user: ["impersonate", "impersonate-admins", "set-password", "set-email", "set-phone"],
  session: ["list"],
} as const;

export const cockpitContextAdminRole = defaultAc.newRole({
  user: ["create", "list", "set-role", "ban", "delete", "get", "update"],
  session: ["revoke", "delete"],
});

// Only `roles` is passed: the plugin checks permissions against `roles`, and
// its `ac` option exists for typing custom statements, which Cockpit Context has none of.
export const adminPluginAccess = {
  roles: {
    admin: cockpitContextAdminRole,
    user: userAc,
  },
};
