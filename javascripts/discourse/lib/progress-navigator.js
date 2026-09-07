import { tracked } from "@glimmer/tracking";
import { schedule } from "@ember/runloop";
import { popupAjaxError } from "discourse/lib/ajax-error";
import { Placeholder } from "discourse/models/post-stream";
import createProgressTrackerModifier from "../modifiers/create-progress-tracker-modifier";

// `component` must expose: postStream, topicModel, site, isNestedView,
// jumpLoading (set), isDestroying, isDestroyed.
export default class ProgressNavigator {
  #component;

  @tracked currentProgressPostNumber = null;
  @tracked scrubberOpen = false;

  constructor(component) {
    this.#component = component;
  }

  progressTracker = createProgressTrackerModifier({
    rootSelector: ".topic-preview-modal .d-modal__body",
    onCurrentPostChange: (postNumber) => {
      this.currentProgressPostNumber = postNumber;
    },
  });

  get progressPost() {
    if (!this.currentProgressPostNumber) {
      return null;
    }
    return (this.#component.postStream?.posts ?? []).find(
      (p) =>
        !(p instanceof Placeholder) &&
        p.post_number === this.currentProgressPostNumber
    );
  }

  get progressPosition() {
    const post = this.progressPost;
    return post ? this.#component.postStream?.progressIndexOfPost(post) : null;
  }

  get progressTotal() {
    return this.#component.postStream?.filteredPostsCount;
  }

  get progressPercent() {
    if (!this.progressPosition || !this.progressTotal) {
      return 0;
    }
    return Math.min(
      100,
      Math.max(0, (this.progressPosition / this.progressTotal) * 100)
    );
  }

  get hideProgress() {
    const component = this.#component;
    const hideOnShortStream =
      component.site.desktopView && (this.progressTotal ?? 0) < 2;
    return (
      component.isNestedView ||
      !component.postStream?.loaded ||
      !this.progressPost ||
      hideOnShortStream
    );
  }

  get showProgressBackButton() {
    const lastReadId = this.#component.topicModel?.last_read_post_id;
    const stream = this.#component.postStream?.stream;
    if (!lastReadId || !stream?.length || this.progressPosition == null) {
      return false;
    }
    const readPos = stream.indexOf(lastReadId);
    return (
      readPos >= 0 &&
      readPos < stream.length - 1 &&
      readPos + 1 > this.progressPosition
    );
  }

  get scrubberEnteredIndex() {
    return Math.max(0, (this.progressPosition ?? 1) - 1);
  }

  openScrubber = () => {
    this.scrubberOpen = true;
  };

  closeScrubber = () => {
    this.scrubberOpen = false;
  };

  jumpToIndex = async (index) => {
    const component = this.#component;
    const stream = component.postStream?.stream;
    if (!stream?.length) {
      return;
    }

    const streamIndex = Math.max(1, Math.min(stream.length, index));
    const postId = stream[streamIndex - 1];
    if (!postId) {
      return;
    }

    try {
      let post = component.postStream.findLoadedPost(postId);
      if (!post) {
        [post] = await component.postStream.findPostsByIds([postId]);
      }
      if (post && !component.isDestroying && !component.isDestroyed) {
        await this.jumpToPost(post.post_number);
      }
    } catch (e) {
      if (!component.isDestroying && !component.isDestroyed) {
        popupAjaxError(e);
      }
    }
  };

  jumpToStart = () => this.jumpToPost(1);

  jumpToEnd = () => {
    const component = this.#component;
    const target = component.topicModel?.highest_post_number ?? this.progressTotal;
    if (target) {
      this.jumpToPost(target);
    }
  };

  goToLastRead = () => {
    this.jumpToPost(this.#component.topicModel?.last_read_post_number);
  };

  jumpToPost = async (postNumber) => {
    const component = this.#component;
    const alreadyLoaded = (component.postStream?.posts ?? []).some(
      (p) => p.post_number === postNumber
    );
    if (!alreadyLoaded) {
      component.jumpLoading = true;
      setTimeout(() => {
        if (!component.isDestroying && !component.isDestroyed) {
          component.jumpLoading = false;
        }
      }, 4000);
    }

    try {
      await component.postStream?.refresh({ nearPost: postNumber });
      if (component.isDestroying || component.isDestroyed) {
        return;
      }
      this.scrollToPost(postNumber, true, 0, () => {
        component.jumpLoading = false;
      });
    } catch (e) {
      component.jumpLoading = false;
      throw e;
    }
  };

  scrollWithinModal(el, smooth = true) {
    const scroller = document.querySelector(
      ".topic-preview-modal .d-modal__body"
    );
    if (!scroller || !el) {
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const topPadding = 12;
    const delta = elRect.top - scrollerRect.top - topPadding;
    scroller.scrollBy({ top: delta, behavior: smooth ? "smooth" : "auto" });
  }

  scrollToPost(postNumber, smooth = true, attempt = 0, onPositioned) {
    schedule("afterRender", () => {
      const el = document.querySelector(
        `.topic-preview-modal [data-post-number="${postNumber}"]`
      );

      if (el) {
        this.scrollWithinModal(el, smooth);
        el.classList.add("highlighted");
        setTimeout(() => el.classList.remove("highlighted"), 1600);

        requestAnimationFrame(() => {
          this.scrollWithinModal(el, false);

          if (onPositioned) {
            setTimeout(() => {
              this.scrollWithinModal(el, false);
              onPositioned();
            }, 150);
          } else {
            setTimeout(() => this.scrollWithinModal(el, false), 150);
          }
        });
      } else if (attempt < 15) {
        setTimeout(
          () =>
            this.scrollToPost(postNumber, smooth, attempt + 1, onPositioned),
          100
        );
      }
    });
  }
}
