import { Button } from "@cockpit-context/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cockpit-context/ui/components/dropdown-menu";
import { ArrowDown, ArrowUp, MoreVertical, Pin, PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePinState, usePinToggle } from "@/hooks/use-pins";

/**
 * Pin or unpin the open conversation (its page header). Disabled, with the
 * reason as its label, while the pins load or when Pinned is full.
 */
export function ConversationPinButton({ id }: { id: string }) {
  const { t } = useTranslation(["dashboard"]);
  const state = usePinState(id);
  const { toggle, isPending } = usePinToggle();
  const label = state.pinned
    ? t("dashboard:pins.unpin")
    : state.full
      ? t("dashboard:pins.full", { count: state.limit })
      : t("dashboard:pins.pin");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-touch"
      className="text-muted-foreground hover:text-foreground aria-pressed:text-foreground"
      aria-label={label}
      title={label}
      aria-pressed={state.ready ? state.pinned : undefined}
      disabled={!state.ready || state.full || isPending}
      onClick={() => toggle(id, state.pinned)}
    >
      {state.pinned ? (
        <PinOff aria-hidden="true" className="size-4" />
      ) : (
        <Pin aria-hidden="true" className="size-4" />
      )}
    </Button>
  );
}

/**
 * A conversation row's menu: pin or unpin it, and in the Pinned section move
 * it up or down (the keyboard and touch alternative to dragging).
 */
export function ConversationRowMenu({
  id,
  title,
  onMoveUp,
  onMoveDown,
}: {
  id: string;
  title: string;
  /** Present in the Pinned section unless the row is first. */
  onMoveUp?: () => void;
  /** Present in the Pinned section unless the row is last. */
  onMoveDown?: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const state = usePinState(id);
  const { toggle, isPending } = usePinToggle();
  const moves = onMoveUp !== undefined || onMoveDown !== undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            className="shrink-0 text-muted-foreground"
            aria-label={t("dashboard:pins.rowActions", { title })}
          />
        }
      >
        <MoreVertical aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {onMoveUp ? (
          <DropdownMenuItem className="min-h-[44px]" onClick={onMoveUp}>
            <ArrowUp aria-hidden="true" className="size-4" />
            {t("dashboard:pins.moveUp")}
          </DropdownMenuItem>
        ) : null}
        {onMoveDown ? (
          <DropdownMenuItem className="min-h-[44px]" onClick={onMoveDown}>
            <ArrowDown aria-hidden="true" className="size-4" />
            {t("dashboard:pins.moveDown")}
          </DropdownMenuItem>
        ) : null}
        {moves ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          className="min-h-[44px]"
          disabled={!state.ready || state.full || isPending}
          onClick={() => toggle(id, state.pinned)}
        >
          {state.pinned ? (
            <PinOff aria-hidden="true" className="size-4" />
          ) : (
            <Pin aria-hidden="true" className="size-4" />
          )}
          {state.pinned
            ? t("dashboard:pins.unpin")
            : state.full
              ? t("dashboard:pins.full", { count: state.limit })
              : t("dashboard:pins.pin")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
