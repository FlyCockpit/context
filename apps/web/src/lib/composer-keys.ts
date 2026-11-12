/**
 * Composer keyboard semantics for the conversation view's steer / follow-up box.
 */

/**
 * Does this keypress mean "send", rather than "insert a newline" or "commit what
 * my IME is composing"?
 *
 * `isComposing` is the load-bearing half and the easy one to omit, because it is
 * invisible on a Latin keyboard. While a Japanese, Chinese, or Korean IME has an
 * active composition, **Enter is how the user accepts the candidate they are
 * looking at** — it belongs to the IME, not to this form. Treating it as submit
 * fires on the first Enter of nearly every multi-character word, sending a
 * half-composed fragment and clearing the draft. The keystroke is not ambiguous;
 * the browser tells us who it is for.
 *
 * Lives in `lib/`, not beside the composer: a non-component export from a
 * component file costs Fast Refresh the ability to preserve state on edit (it
 * has to full-reload instead). It is also the one piece of composer logic that
 * is pure, and therefore the only part reachable from a unit test at all — this
 * app tests no components, see docs/development.md.
 */
export const isSendKey = (event: {
  key: string;
  shiftKey: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean => event.key === "Enter" && !event.shiftKey && event.nativeEvent?.isComposing !== true;
