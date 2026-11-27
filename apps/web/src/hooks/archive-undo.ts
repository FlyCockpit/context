import { toast } from "@cockpit-context/ui/components/sileo";

/**
 * How long the "User archived" toast (and its Undo) stays up. Longer than a
 * plain success toast: the admin has to notice it and reach the button.
 */
export const ARCHIVE_UNDO_TOAST_MS = 8_000;

/**
 * Archiving a user acts at once (no confirm dialog), so the success toast
 * carries an Undo that restores the user. Undo calls the same
 * Notice that toast Undo passes the response's `undoToken` to `users.unarchive`
 * so both the ban and the newly-revoked MCP/OAuth connections are restored,
 * whereas the row's "Restore user" action calls `users.unarchive` without a
 * token (lifting only the ban).
 */
export function announceArchivedWithUndo({
  message,
  undoLabel,
  onUndo,
}: {
  message: string;
  undoLabel: string;
  onUndo: () => void;
}): string {
  // Single-shot guard + immediate dismiss so double-clicking Undo before the
  // exiting transition completes cannot fire a duplicate unarchive request.
  let triggered = false;
  let toastId = "";
  toastId = toast.success(message, {
    duration: ARCHIVE_UNDO_TOAST_MS,
    action: {
      label: undoLabel,
      onClick: () => {
        if (triggered) return;
        triggered = true;
        if (toastId) toast.dismiss?.(toastId);
        onUndo();
      },
    },
  });
  return toastId;
}
