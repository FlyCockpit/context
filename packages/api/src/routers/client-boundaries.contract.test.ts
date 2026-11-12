import type { RouterClient } from "@orpc/server";

import type { usersRouter } from "./users";

type IsExact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2
    ? (<T>() => T extends Expected ? 1 : 2) extends <T>() => T extends Actual ? 1 : 2
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

type UsersClient = RouterClient<typeof usersRouter>;
type ListedUser = Awaited<ReturnType<UsersClient["list"]>>["users"][number];
/**
 * The admin user-list projection, pinned at the client boundary. Credential
 * and session fields are what this assertion exists to keep out: adding one to
 * `USER_SELECT` would put it on the wire for every row, and only a
 * compile-time exact-type check notices a projection that grew.
 */
export type UsersRouterListContract = Assert<
  IsExact<
    ListedUser,
    {
      id: string;
      email: string;
      name: string;
      role: string;
      emailVerified: boolean;
      banned: boolean | null;
      banReason: string | null;
      banExpires: Date | null;
      twoFactorEnabled: boolean | null;
      image: string | null;
      createdAt: Date;
      updatedAt: Date;
    }
  >
>;
