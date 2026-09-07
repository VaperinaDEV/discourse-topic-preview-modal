import AnonymousFlagModal from "discourse/components/modal/anonymous-flag";
import ChangeOwnerModal from "discourse/components/modal/change-owner";
import ChangePostNoticeModal from "discourse/components/modal/change-post-notice";
import FlagModal from "discourse/components/modal/flag";
import GrantBadgeModal from "discourse/components/modal/grant-badge";
import HistoryModal from "discourse/components/modal/history";
import PermanentlyDeleteConfirmModal from "discourse/components/modal/permanently-delete-confirm";
import RawEmailModal from "discourse/components/modal/raw-email";
import PostFlag from "discourse/lib/flag-targets/post-flag";
import { ajax } from "discourse/lib/ajax";
import { popupAjaxError } from "discourse/lib/ajax-error";
import DiscourseURL from "discourse/lib/url";
import { i18n } from "discourse-i18n";
import { guardPost } from "./guard-post";

// Post moderation actions, opened as sub-modals so they don't close the
// topic preview itself. `component` must expose: dialog, currentUser,
// site (services), topicModel, closeModal(), openFull(), showSubModal(),
// composerInteractions.
export default class TopicPreviewPostActions {
  #component;

  constructor(component) {
    this.#component = component;
  }

  deletePost = async (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    const component = this.#component;
    if (post.post_number === 1) {
      return component.openFull();
    }
    if (!post.can_delete) {
      return;
    }
    component.dialog.yesNoConfirm({
      message: i18n("post.confirm_delete"),
      didConfirm: async () => {
        try {
          await post.destroy(component.currentUser);
        } catch (e) {
          popupAjaxError(e);
          post.undoDeleteState();
        }
      },
    });
  };

  recoverPost = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    if (post.post_number === 1) {
      return this.#component.openFull();
    }
    return post.recover();
  };

  permanentlyDeletePost = async (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    const component = this.#component;
    let result;
    try {
      result = await ajax(`/posts/${post.id}/permanently_delete_check.json`);
    } catch (e) {
      return popupAjaxError(e);
    }
    if (!result.can_permanently_delete) {
      return component.dialog.alert(result.reason);
    }
    component.showSubModal(PermanentlyDeleteConfirmModal, {
      message: i18n("post.controls.permanently_delete_post_confirmation"),
      confirmPhrase: i18n("post.controls.permanently_delete_confirm_phrase"),
      didConfirm: async () => {
        try {
          await post.destroy(component.currentUser, { force_destroy: true });
        } catch (e) {
          popupAjaxError(e);
        }
      },
    });
  };

  lockPost = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    return post.updatePostField("locked", true);
  };

  unlockPost = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    return post.updatePostField("locked", false);
  };

  toggleWiki = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    return post.updatePostField("wiki", !post.wiki);
  };

  togglePostType = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    const { regular, moderator_action: moderator } =
      this.#component.site.post_types;
    return post.updatePostField(
      "post_type",
      post.post_type === moderator ? regular : moderator
    );
  };

  rebakePost = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    return post.rebake();
  };

  unhidePost = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    return post.unhide();
  };

  expandHidden = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    return post.expandHidden();
  };

  changeNotice = async (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    await this.#component.showSubModal(ChangePostNoticeModal, { post });
  };

  changePostOwner = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    const component = this.#component;
    component.showSubModal(ChangeOwnerModal, {
      selectedPostsCount: 1,
      selectedPostIds: [post.id],
      selectedPostsUsername: post.username,
      multiSelect: false,
      deselectAll: () => {},
      toggleMultiSelect: () => {},
      topic: post.topic ?? component.topicModel,
    });
  };

  grantBadge = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    this.#component.showSubModal(GrantBadgeModal, { selectedPost: post });
  };

  showFlags = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    const component = this.#component;
    component.showSubModal(
      component.currentUser ? FlagModal : AnonymousFlagModal,
      {
        flagTarget: new PostFlag(),
        flagModel: post,
        setHidden: () => post.set("hidden", true),
      }
    );
  };

  showHistory = (post, revision) => {
    if (!(post = guardPost(post))) {
      return;
    }
    const component = this.#component;
    component.showSubModal(HistoryModal, {
      postId: post.id,
      postVersion: revision || "latest",
      post,
      editPost: (p) => component.composerInteractions.editPost(p),
    });
  };

  showRawEmail = (post) => {
    if (!(post = guardPost(post))) {
      return;
    }
    this.#component.showSubModal(RawEmailModal, post);
  };

  showLogin = () => {
    const component = this.#component;
    component.closeModal();
    DiscourseURL.redirectTo("/login");
  };

  showPagePublish = () => this.#component.openFull();
  showInvite = () => this.#component.openFull();
  removeAllowedGroup = () => this.#component.openFull();
  removeAllowedUser = () => this.#component.openFull();
  selectBelow = () => this.#component.openFull();
  selectReplies = () => this.#component.openFull();
  cancelFilter = () => {};
}
