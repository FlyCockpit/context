import { Toaster as SileoToaster, sileo } from "sileo";
import "sileo/styles.css";

interface ToasterProps {
  position?:
    | "top-left"
    | "top-center"
    | "top-right"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right";
}

// No `theme`: sileo's themes invert the page (a light pill on a dark app).
// The toast takes the app's popover tokens from globals.css instead, so it
// follows `.dark` like every other surface, with no JS theme state.
const Toaster = ({ position = "bottom-center", ...props }: ToasterProps) => (
  <SileoToaster position={position} {...props} />
);

type ToastOptions = {
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
};

// sileo keys toasts by `id` and defaults every one to "sileo-default", so a
// second toast replaces (morphs into) the first: two messages merge into one
// blob and the first is lost. Each toast gets its own id, so they stack.
let toastCount = 0;
const nextToastId = () => `toast-${++toastCount}`;

// The pill is one line, at most 350px wide (sileo's fixed SVG width). Longer
// messages are cut with an ellipsis in the pill (globals.css), so the full
// text also goes in the description, which sileo expands under the pill.
const PILL_MAX_CHARS = 40;

function createToastMethod(method: "success" | "error" | "info" | "warning" | "show") {
  return (message: string, options?: ToastOptions): string => {
    const id = nextToastId();
    sileo[method]({
      id,
      title: message,
      ...(message.length > PILL_MAX_CHARS ? { description: message } : {}),
      ...(options?.duration != null ? { duration: options.duration } : {}),
      ...(options?.action
        ? { button: { title: options.action.label, onClick: options.action.onClick } }
        : {}),
      // `id` is honoured at runtime (sileo 0.1.6 reads `options.id`) but is
      // missing from its published options type.
    } as Parameters<typeof sileo.show>[0]);
    return id;
  };
}

const toast = {
  /** Neutral, polite notice — no success/error severity styling. */
  message: createToastMethod("show"),
  success: createToastMethod("success"),
  error: createToastMethod("error"),
  info: createToastMethod("info"),
  warning: createToastMethod("warning"),
  dismiss: sileo.dismiss,
  clear: sileo.clear,
};

export { Toaster, toast };
