import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { on } from "@ember/modifier";
import { action } from "@ember/object";
import { schedule } from "@ember/runloop";
import TopicTimeline from "discourse/components/topic-timeline";
import DButton from "discourse/components/d-button";
import DModal from "discourse/components/d-modal";
import { i18n } from "discourse-i18n";

const SWIPE_DIRECTION_THRESHOLD_PX = 5;

export default class TopicPreviewModalProgressScrubberOverlay extends Component {
  @tracked promptOpen = false;
  @tracked promptValue = "";

  #timelineScrollArea = null;
  #startX = null;
  #startY = null;

  noop = () => {};

  constructor(owner, args) {
    super(owner, args);

    schedule("afterRender", this.#setupTimelineGesture);
  }

  get totalPosts() {
    return this.args.topicModel?.postStream?.filteredPostsCount;
  }

  #setupTimelineGesture = () => {
    const scrollArea = document.querySelector(
      ".topic-preview-modal__scrubber-modal .timeline-scrollarea"
    );

    if (!scrollArea || scrollArea === this.#timelineScrollArea) {
      return;
    }

    this.#timelineScrollArea = scrollArea;

    scrollArea.addEventListener(
      "touchstart",
      this.#onTimelineTouchStart,
      { capture: true, passive: true }
    );

    scrollArea.addEventListener(
      "touchmove",
      this.#onTimelineTouchMove,
      { capture: true, passive: false }
    );

    scrollArea.addEventListener(
      "touchend",
      this.#onTimelineTouchEnd,
      { capture: true }
    );

    scrollArea.addEventListener(
      "touchcancel",
      this.#onTimelineTouchEnd,
      { capture: true }
    );
  };

  #onTimelineTouchStart = (event) => {
    if (event.touches.length !== 1) {
      this.#resetTimelineTouch();
      return;
    }

    const touch = event.touches[0];

    this.#startX = touch.clientX;
    this.#startY = touch.clientY;
  };

  #onTimelineTouchMove = (event) => {
    if (
      this.#startX === null ||
      this.#startY === null ||
      event.touches.length !== 1
    ) {
      return;
    }

    const touch = event.touches[0];
    const deltaX = touch.clientX - this.#startX;
    const deltaY = touch.clientY - this.#startY;

    if (
      Math.abs(deltaX) < SWIPE_DIRECTION_THRESHOLD_PX &&
      Math.abs(deltaY) < SWIPE_DIRECTION_THRESHOLD_PX
    ) {
      return;
    }

    // DModal dismisses on a swipe. Claim that gesture before
    // it reaches the modal, while leaving timeline dragging alone.
    if (Math.abs(deltaY) > Math.abs(deltaX)) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  #onTimelineTouchEnd = () => {
    this.#resetTimelineTouch();
  };

  #resetTimelineTouch() {
    this.#startX = null;
    this.#startY = null;
  }

  #removeTimelineGestureListeners() {
    const scrollArea = this.#timelineScrollArea;

    if (!scrollArea) {
      return;
    }

    scrollArea.removeEventListener(
      "touchstart",
      this.#onTimelineTouchStart,
      { capture: true }
    );

    scrollArea.removeEventListener(
      "touchmove",
      this.#onTimelineTouchMove,
      { capture: true }
    );

    scrollArea.removeEventListener(
      "touchend",
      this.#onTimelineTouchEnd,
      { capture: true }
    );

    scrollArea.removeEventListener(
      "touchcancel",
      this.#onTimelineTouchEnd,
      { capture: true }
    );

    this.#timelineScrollArea = null;
  }

  @action
  jumpTop(event) {
    event?.preventDefault?.();
    this.args.onJumpToStart?.();
    this.args.onClose?.();
  }

  @action
  jumpEnd(event) {
    event?.preventDefault?.();
    this.args.onJumpToEnd?.();
    this.args.onClose?.();
  }

  @action
  jumpToIndex(index) {
    this.args.onJumpToIndex?.(index);
    this.args.onClose?.();
  }

  @action
  openPrompt() {
    this.promptValue = "";
    this.promptOpen = true;
  }

  @action
  closePrompt() {
    this.promptOpen = false;
  }

  @action
  updatePromptValue(event) {
    this.promptValue = event.target.value;
  }

  @action
  submitPrompt(event) {
    event?.preventDefault?.();

    const total = this.totalPosts;
    const parsed = parseInt(this.promptValue, 10);

    if (Number.isNaN(parsed)) {
      return;
    }

    const index = total
      ? Math.min(total, Math.max(1, parsed))
      : Math.max(1, parsed);

    this.promptOpen = false;
    this.jumpToIndex(index);
  }

  @action
  promptKeydown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.closePrompt();
    }
  }

  willDestroy() {
    this.#removeTimelineGestureListeners();
    super.willDestroy();
  }

  <template>
    <DModal
      @closeModal={{@onClose}}
      @title={{i18n "js.user_tips.topic_timeline.title"}}
      @dismissable={{true}}
      class="topic-preview-modal__scrubber-modal"
    >
      <:body>
        <TopicTimeline
          @model={{@topicModel}}
          @fullscreen={{true}}
          @enteredIndex={{@enteredIndex}}
          @jumpTop={{this.jumpTop}}
          @jumpBottom={{this.jumpEnd}}
          @jumpEnd={{this.jumpEnd}}
          @jumpToIndex={{this.jumpToIndex}}
          @jumpToPostPrompt={{this.openPrompt}}
          @replyToPost={{this.noop}}
          @toggleMultiSelect={{this.noop}}
          @showTopicSlowModeUpdate={{this.noop}}
          @showTopReplies={{this.noop}}
          @deleteTopic={{this.noop}}
          @recoverTopic={{this.noop}}
          @toggleClosed={{this.noop}}
          @toggleArchived={{this.noop}}
          @toggleVisibility={{this.noop}}
          @showTopicTimerModal={{this.noop}}
          @showFeatureTopic={{this.noop}}
          @showChangeTimestamp={{this.noop}}
          @resetBumpDate={{this.noop}}
          @convertToPublicTopic={{this.noop}}
          @convertToPrivateMessage={{this.noop}}
        />
      </:body>

      <:footer>
        {{#if this.promptOpen}}
          <div class="topic-preview-modal__scrubber-prompt">
            <label for="topic-preview-modal-jump-prompt">
              {{i18n (themePrefix "topic_preview.jump_to_post_label")}}
            </label>

            {{! template-lint-disable require-input-label }}
            <input
              id="topic-preview-modal-jump-prompt"
              type="number"
              min="1"
              max={{this.totalPosts}}
              value={{this.promptValue}}
              autofocus="true"
              {{on "input" this.updatePromptValue}}
              {{on "keydown" this.promptKeydown}}
            />

            <DButton
              class="btn-primary btn-small"
              @translatedLabel={{i18n (themePrefix "topic_preview.jump_to_post_go")}}
              @action={{this.submitPrompt}}
            />
          </div>
        {{/if}}
      </:footer>
    </DModal>
  </template>
}
