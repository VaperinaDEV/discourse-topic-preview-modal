import { schedule } from "@ember/runloop";
import { addObserver, removeObserver } from "@ember/object/observers";
import { buildQuote } from "discourse/lib/quote";
import QuoteState from "discourse/lib/quote-state";
import Composer from "discourse/models/composer";
import Draft from "discourse/models/draft";
import { i18n } from "discourse-i18n";
import { guardPost } from "./guard-post";

// `component` must expose: composer, dialog, currentUser (services),
// topicModel, topicId, postStream, activeSubModal, closeSubModal(),
// fkMenuCloseTimer, overlayWatcher, isDestroying, isDestroyed.
export default class TopicPreviewComposerInteractions {
  #component;

  quoteState = new QuoteState();

  constructor(component) {
    this.#component = component;
  }

  start() {
    const component = this.#component;
    addObserver(
      component.composer,
      "model.composeState",
      this.handleComposerStateChange
    );
    document.addEventListener("focusin", this.handleDocumentFocusIn, true);
  }

  stop() {
    const component = this.#component;
    removeObserver(
      component.composer,
      "model.composeState",
      this.handleComposerStateChange
    );
    document.removeEventListener("focusin", this.handleDocumentFocusIn, true);
  }

  get composerOpen() {
    const state = this.#component.composer.model?.composeState;
    return !!state && state !== Composer.DRAFT && state !== Composer.CLOSED;
  }

  scheduleComposerFocusGuard() {
    const component = this.#component;
    [150, 700].forEach((delay) => {
      setTimeout(() => {
        if (
          component.isDestroying ||
          component.isDestroyed ||
          !this.composerOpen
        ) {
          return;
        }
        if (
          component.activeSubModal ||
          document.querySelector(".fk-d-menu, .fk-d-menu-modal, .fk-d-tooltip")
        ) {
          return;
        }
        const composerEl = document.querySelector("#reply-control");
        if (!composerEl) {
          return;
        }
        const active = document.activeElement;
        if (active && composerEl.contains(active)) {
          return;
        }
        if (typeof component.composer.focusComposer === "function") {
          component.composer.focusComposer();
        } else {
          composerEl.querySelector("textarea.d-editor-input")?.focus();
        }
      }, delay);
    });
  }

  handleDocumentFocusIn = (event) => {
    const component = this.#component;
    if (!this.composerOpen || component.activeSubModal) {
      return;
    }
    const composerEl = document.querySelector("#reply-control");
    if (!composerEl || composerEl.contains(event.target)) {
      return;
    }
    const legitPopup = document.querySelector(
      ".fk-d-menu, .fk-d-menu-modal, .fk-d-tooltip"
    );
    if (legitPopup?.contains(event.target)) {
      return;
    }
    schedule("afterRender", () => {
      if (
        component.isDestroying ||
        component.isDestroyed ||
        !this.composerOpen
      ) {
        return;
      }
      if (typeof component.composer.focusComposer === "function") {
        component.composer.focusComposer();
      } else {
        composerEl.querySelector("textarea.d-editor-input")?.focus();
      }
    });
  };

  handleComposerStateChange = () => {
    const component = this.#component;
    const state = component.composer.model?.composeState;
    const composerGone =
      !state || state === Composer.CLOSED || state === Composer.DRAFT;
    if (!composerGone) {
      window.getSelection()?.removeAllRanges();
      this.scheduleComposerFocusGuard();
      return;
    }
    if (component.activeSubModal) {
      component.closeSubModal();
    }
    component.overlayWatcher.syncImmediate();
  };

  replyToTopic = async () => {
    const component = this.#component;
    const opts = {
      action: Composer.REPLY,
      draftKey: component.topicModel?.draft_key ?? `topic_${component.topicId}`,
      draftSequence: component.topicModel?.draft_sequence ?? 0,
      topic: component.topicModel,
    };

    await this.#loadDraftInto(opts);

    component.composer.open(opts);
  };

  replyToPost = async (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    const component = this.#component;
    const opts = {
      action: Composer.REPLY,
      draftKey: component.topicModel?.draft_key ?? `topic_${component.topicId}`,
      draftSequence: component.topicModel?.draft_sequence ?? 0,
      topic: component.topicModel,
      post,
    };

    await this.#loadDraftInto(opts);

    component.composer.open(opts);
  };

  #loadDraftInto = async (opts) => {
    if (opts.quote) {
      return;
    }
    try {
      const draftData = await Draft.get(opts.draftKey);
      if (draftData?.draft) {
        const data = JSON.parse(draftData.draft);
        opts.reply = data.reply;
        opts.draftSequence = draftData.draft_sequence;
      }
    } catch {
      // ignore
    }
  };

  editPost = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    const component = this.#component;
    if (!component.currentUser) {
      return component.dialog.alert(i18n("post.controls.edit_anonymous"));
    }
    if (!post.can_edit) {
      return false;
    }
    return component.composer.open({
      post,
      action: Composer.EDIT,
      draftKey: post.get("topic.draft_key"),
      draftSequence: post.get("topic.draft_sequence"),
    });
  };

  selectText = async () => {
    const { postId } = this.quoteState;
    const postStream = this.#component.postStream;
    const { markdown: buffer, opts } = await this.quoteState.markdown();
    const loadedPost = postStream.findLoadedPost(postId);
    const post = loadedPost ? loadedPost : await postStream.loadPost(postId);

    const composerOpts = {
      action: Composer.REPLY,
      draftSequence: post.get("topic.draft_sequence"),
      draftKey: post.get("topic.draft_key"),
    };

    if (post.get("post_number") === 1) {
      composerOpts.topic = post.get("topic");
    } else {
      composerOpts.post = post;
    }

    composerOpts.quote = buildQuote(post, buffer, opts);
    this.quoteState.clear();
    await this.#component.composer.open(composerOpts);
  };

  buildQuoteMarkdown = async () => {
    const { postId } = this.quoteState;
    const postStream = this.#component.postStream;
    const { markdown: buffer, opts } = await this.quoteState.markdown();
    const loadedPost = postStream.findLoadedPost(postId);
    const post = loadedPost ? loadedPost : await postStream.loadPost(postId);
    return buildQuote(post, buffer, opts);
  };
}
