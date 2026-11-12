// Loaded lazily by `MotionProvider` so the animation engine (springs, gestures,
// drag, layout) lands in its own chunk instead of the first-paint bundle.
// `domMax` is the full feature set; it is the reason this library is here at
// all — CSS already covers plain fades and slides.
export { domMax as default } from "motion/react";
