import { Bot } from "lucide-react";

/**
 * Who is asking: the OAuth client's display name (client-supplied at
 * registration, so plain text only, never its remote logo) over a short
 * caption.
 */
export function ClientTile({ name, caption }: { name: string; caption: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border bg-muted/40 p-3">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary-text"
      >
        <Bot className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="font-semibold break-words" data-testid="client-name">
          {name}
        </p>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
    </div>
  );
}
