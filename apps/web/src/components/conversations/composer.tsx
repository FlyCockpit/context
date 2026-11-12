import { Button } from "@cockpit-context/ui/components/button";
import { Textarea } from "@cockpit-context/ui/components/textarea";
import { Send, Square } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { isSendKey } from "@/lib/composer-keys";
import type { ComposerMode } from "@/lib/conversations";

/** Mirrors the `conversations.steer` / `send` input ceiling. */
const MAX_MESSAGE_LENGTH = 20_000;

/**
 * The conversation's input box. While the run is live it steers ("Steer the
 * agent…", Send + Stop); once it finished it asks a follow-up. Disabled,
 * with the reason, while the checkout is being prepared or re-created, while
 * the final answer is being written, or when the package is gone. The AI
 * disclosure sits under it for the whole conversation
 * (docs/product.md).
 */
export function Composer({
  mode,
  live,
  submitting,
  stopping,
  onSubmit,
  onStop,
}: {
  mode: ComposerMode;
  /** The main run is queued or running: offer Stop. */
  live: boolean;
  submitting: boolean;
  stopping: boolean;
  /** Resolves `true` when the message was accepted; only then is the draft cleared. */
  onSubmit: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [text, setText] = useState("");
  const hintId = useId();
  const disabled = mode.kind === "disabled";
  const steering = mode.kind === "steer" || (mode.kind === "disabled" && mode.live);

  const submit = async () => {
    const value = text.trim();
    if (!value || value.length > MAX_MESSAGE_LENGTH || disabled || submitting) return;
    // The draft survives a failed send: retyping a long instruction because
    // the run had just finished is how you lose someone's trust.
    if (await onSubmit(value)) setText("");
  };

  const hint =
    mode.kind === "disabled"
      ? t(`dashboard:conversation.composer.disabled.${mode.reason}`)
      : mode.kind === "followUp" && mode.recreatesCheckout
        ? t("dashboard:conversation.composer.recreateNotice")
        : mode.kind === "steer"
          ? t("dashboard:conversation.composer.steerHint")
          : t("dashboard:conversation.composer.followUpHint");

  return (
    <form
      noValidate
      className="min-w-0 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex min-w-0 items-end gap-2">
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (isSendKey(event)) {
              event.preventDefault();
              void submit();
            }
          }}
          disabled={disabled}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={2}
          inputMode="text"
          autoComplete="off"
          aria-label={
            steering
              ? t("dashboard:conversation.composer.steerLabel")
              : t("dashboard:conversation.composer.followUpLabel")
          }
          aria-describedby={hintId}
          placeholder={
            steering
              ? t("dashboard:conversation.composer.steerPlaceholder")
              : t("dashboard:conversation.composer.followUpPlaceholder")
          }
          className="max-h-48 min-h-[52px] min-w-0 resize-none overflow-x-hidden overflow-y-auto rounded-md text-base md:text-sm"
        />
        <div className="flex shrink-0 gap-2">
          {live ? (
            <Button
              type="button"
              variant="outline"
              size="touch"
              onClick={onStop}
              disabled={stopping}
              aria-label={t("dashboard:conversation.composer.stop")}
            >
              <Square aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">
                {stopping
                  ? t("dashboard:conversation.composer.stopping")
                  : t("dashboard:conversation.composer.stop")}
              </span>
            </Button>
          ) : null}
          <Button
            type="submit"
            size="touch"
            disabled={disabled || submitting || !text.trim()}
            aria-label={
              steering
                ? t("dashboard:conversation.composer.sendSteer")
                : t("dashboard:conversation.composer.send")
            }
          >
            <Send aria-hidden="true" className="size-4" />
            <span className="hidden sm:inline">
              {steering
                ? t("dashboard:conversation.composer.sendSteer")
                : t("dashboard:conversation.composer.send")}
            </span>
          </Button>
        </div>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground" aria-live="polite">
        {hint}
      </p>
      <p className="text-xs text-muted-foreground">{t("dashboard:conversation.aiDisclosure")}</p>
    </form>
  );
}
