import { Button } from "@cockpit-context/ui/components/button";
import { Card, CardContent } from "@cockpit-context/ui/components/card";
import { cn } from "@cockpit-context/ui/lib/utils";
import { GripVertical, Pin } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConversationRowMenu } from "@/components/conversations/conversation-pin";
import { ConversationRow } from "@/components/conversations/conversation-row";
import { QueryBoundary } from "@/components/query-boundary";
import { useMountEffect } from "@/hooks/use-mount-effect";
import { usePinReorder, usePins } from "@/hooks/use-pins";
import type { ConversationListItem } from "@/lib/conversations";
import { dropIndex, moveItem, sameMembers, sameOrder } from "@/lib/pins";

type Drag = { id: string; pointerId: number; order: string[] };

/**
 * The home's Pinned section, above Live and Recent: the conversations the
 * user pinned, in their order. Hidden when there are none (and while the
 * first read is in flight, so a user without pins never sees a placeholder
 * flash). Reorder by dragging a row's handle, with the arrow keys on the
 * focused handle, or with Move up / Move down in the row menu.
 */
export function PinnedSection({ lang, now }: { lang: string; now: number }) {
  const { t } = useTranslation(["dashboard"]);
  const pins = usePins();
  const reorder = usePinReorder();
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rows = useRef(new Map<string, HTMLLIElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const hintId = useId();
  /** Ends a drag in progress without saving it (set while one is). */
  const stopDrag = useRef<(() => void) | null>(null);
  // Leaving the page mid-drag drops the drag: its window listeners go, nothing is saved.
  useMountEffect(() => () => stopDrag.current?.());

  // Nothing until the first read lands, and nothing while there are no pins.
  if (pins.isPending) return null;
  const items = pins.data?.items ?? [];
  if (pins.data && items.length === 0) return null;

  const cached = items.map((item) => item.id);
  // A move still being saved wins over what a background re-read returned.
  const saved = reorder.desired && sameMembers(reorder.desired, cached) ? reorder.desired : cached;
  const order = drag?.order ?? saved;
  const byId = new Map(items.map((item) => [item.id, item]));
  const shown = order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });

  const commit = (next: string[], moved: ConversationListItem) => {
    if (sameOrder(next, saved)) return;
    reorder.save(next);
    setAnnouncement(
      t("dashboard:pins.moved", {
        title: moved.title,
        position: next.indexOf(moved.id) + 1,
        count: next.length,
      }),
    );
  };

  const move = (item: ConversationListItem, by: number) => {
    const from = saved.indexOf(item.id);
    const next = moveItem(saved, from, from + by);
    commit(next, item);
    // Keep the keyboard on the handle that moved (re-rendering can drop focus).
    requestAnimationFrame(() => handles.current.get(item.id)?.focus());
  };

  /**
   * Track the drag on the window, not on the handle: moving the dragged row
   * in the list moves its DOM node, which releases pointer capture, so the
   * handle stops receiving the pointer's events. The listeners live from
   * pointer-down to pointer-up/cancel; the live order is in a ref so they
   * never read a stale render.
   */
  const onPointerDown =
    (item: ConversationListItem) => (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (dragRef.current) return;
      event.preventDefault();
      const { pointerId } = event;
      dragRef.current = { id: item.id, pointerId, order: saved };
      setDrag(dragRef.current);
      const onMove = (move: globalThis.PointerEvent) => {
        const current = dragRef.current;
        if (!current || move.pointerId !== pointerId) return;
        const measured = current.order.flatMap((id) => {
          const rect = rows.current.get(id)?.getBoundingClientRect();
          return rect ? [{ id, top: rect.top, height: rect.height }] : [];
        });
        const to = dropIndex(measured, current.id, move.clientY);
        const next = moveItem(current.order, current.order.indexOf(current.id), to);
        if (sameOrder(next, current.order)) return;
        dragRef.current = { ...current, order: next };
        setDrag(dragRef.current);
      };
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        stopDrag.current = null;
        dragRef.current = null;
      };
      const finish = (cancelled: boolean) => (end: globalThis.PointerEvent) => {
        if (end.pointerId !== pointerId) return;
        const final = dragRef.current;
        detach();
        setDrag(null);
        if (!cancelled && final) commit(final.order, item);
      };
      const onUp = finish(false);
      const onCancel = finish(true);
      stopDrag.current = detach;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };

  const onKeyDown = (item: ConversationListItem) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      move(item, event.key === "ArrowUp" ? -1 : 1);
    }
  };

  return (
    <section aria-labelledby="home-pinned-title" className="space-y-3">
      <h2 id="home-pinned-title" className="flex items-center gap-2 text-base font-semibold">
        <Pin aria-hidden="true" className="size-4 text-muted-foreground" />
        {t("dashboard:pins.title")}
      </h2>
      <p id={hintId} className="sr-only">
        {t("dashboard:pins.reorderHint")}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <Card className="py-0">
        <CardContent className="p-0">
          {/* A failed refetch keeps the loaded rows, with a retry banner above them. */}
          <QueryBoundary
            query={pins}
            skeleton={null}
            errorMessage={t("dashboard:pins.loadFailed")}
            errorClassName="py-8"
          >
            {() => (
              <ul className="divide-y" data-slot="pinned-list">
                {shown.map((item, index) => (
                  <li
                    key={item.id}
                    ref={(node) => {
                      if (node) rows.current.set(item.id, node);
                      else rows.current.delete(item.id);
                    }}
                    data-dragging={drag?.id === item.id ? "" : undefined}
                    className={cn(
                      "bg-card",
                      drag?.id === item.id && "relative z-10 shadow-md ring-2 ring-ring",
                    )}
                  >
                    <ConversationRow
                      item={item}
                      lang={lang}
                      now={now}
                      leading={
                        shown.length > 1 ? (
                          <Button
                            ref={(node: HTMLButtonElement | null) => {
                              if (node) handles.current.set(item.id, node);
                              else handles.current.delete(item.id);
                            }}
                            type="button"
                            variant="ghost"
                            size="icon-touch"
                            // Dragging must not scroll the page or pull to refresh.
                            data-pull-to-refresh="off"
                            className={cn(
                              "ms-1 shrink-0 touch-none text-muted-foreground",
                              drag ? "cursor-grabbing" : "cursor-grab",
                            )}
                            aria-label={t("dashboard:pins.reorder", { title: item.title })}
                            aria-describedby={hintId}
                            onPointerDown={onPointerDown(item)}
                            onKeyDown={onKeyDown(item)}
                          >
                            <GripVertical aria-hidden="true" className="size-4" />
                          </Button>
                        ) : undefined
                      }
                      actions={
                        <ConversationRowMenu
                          id={item.id}
                          title={item.title}
                          onMoveUp={index > 0 ? () => move(item, -1) : undefined}
                          onMoveDown={index < shown.length - 1 ? () => move(item, 1) : undefined}
                        />
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>
    </section>
  );
}
