import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/access` opens its first tab. */
export const Route = createFileRoute("/$lang/_app/_auth/access/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$lang/access/tokens", params: { lang: params.lang }, replace: true });
  },
});
