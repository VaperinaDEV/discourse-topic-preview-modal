const OPEN_HAPTIC_DURATION = 15;
const CLOSE_HAPTIC_DURATION = 35;

export function triggerHaptic(capabilities, type) {
  if (
    settings.modal_haptic_feedback &&
    capabilities.userHasBeenActive &&
    capabilities.canVibrate
  ) {
    const duration =
      type === "open" ? OPEN_HAPTIC_DURATION : CLOSE_HAPTIC_DURATION;

    navigator.vibrate(duration);
  }
}
