import { LazyMotion, MotionConfig } from "motion/react";
import type * as React from "react";

// The single entry point to the Motion library. See docs/development.md
// § Motion — when CSS is not enough.
//
// - `LazyMotion strict` keeps the first-paint cost to the tiny `m` renderer;
//   the feature bundle loads in its own chunk. `strict` makes a stray
//   `motion.div` (which would pull the whole library into the importing chunk)
//   throw in development instead of silently bloating the bundle — use `m.*`.
// - `reducedMotion="user"` makes every Motion animation honour
//   `prefers-reduced-motion`: transforms and layout animations are skipped,
//   opacity and color still change. This is the JS-side counterpart of the
//   global override in globals.css.
const loadFeatures = () => import("./motion-features").then((mod) => mod.default);

function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

export type { Transition, Variants } from "motion/react";
export {
  AnimatePresence,
  LayoutGroup,
  m,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";
export { MotionProvider };
