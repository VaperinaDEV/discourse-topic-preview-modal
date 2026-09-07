import { tracked } from "@glimmer/tracking";

const SEEN_KEY = "discourse_topic_preview_modal.seen_back_gesture_hint";

export default class BackGestureHint {
  #timer = null;

  @tracked show = false;
  @tracked fading = false;

  maybeShow() {
    if (!settings.always_show_dismiss_hint) {
      try {
        if (localStorage.getItem(SEEN_KEY)) {
          return;
        }
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        // ignore
      }
    }

    this.show = true;

    if (settings.dismiss_hint_duration_ms === -1) {
      return;
    }

    this.#timer = setTimeout(() => {
      this.fading = true;
    }, settings.dismiss_hint_duration_ms);
  }

  handleAnimationEnd = () => {
    if (this.fading) {
      this.show = false;
      this.fading = false;
    }
  };

  stop() {
    clearTimeout(this.#timer);
  }
}
