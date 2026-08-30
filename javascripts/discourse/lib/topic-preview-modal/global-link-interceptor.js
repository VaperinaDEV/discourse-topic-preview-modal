import TopicPreviewModal from "../../components/modal/topic-preview-modal";
import { trackTopicVisit } from "./prefetch";
import { matchTopicLink } from "./topic-link";
import { triggerHaptic } from "./haptic";

// Installs a single, capture-phase document click listener that opens the
// preview modal for ANY link pointing to a topic, anywhere on the page —
// post content, notifications, user card "recent topics", search results,
// suggested/related topics, sidebar, etc.
//
// Deliberately left alone (NOT intercepted here — each has its own, already
// correct behavior):
//   - .topic-list-item        -> handled by click.gjs / button-trigger.gjs
//                                 (prefetch, exclusions like user-card/tags).
//   - .topic-preview-modal    -> handled by the modal's own
//                                 handleInternalLinkClick (same-topic jump)
//                                 and the DiscourseURL.routeTo patch
//                                 (different-topic -> close + navigate away,
//                                 see service-patches.js for why).
//   - the topic you're already reading on its own full page -> let core's
//     normal in-page post jump handle it instead of popping a modal on top
//     of the page that's already showing that same topic.
//
// Called once from the api-initializer when settings.open_all_topic_links
// is enabled.
export function installGlobalTopicLinkInterceptor(api) {
  document.addEventListener(
    "click",
    (event) => handleClick(event, api),
    true
  );
}

function handleClick(event, api) {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  const link = event.target.closest?.("a[href]");
  if (!link) {
    return;
  }

  const rawHref = link.getAttribute("href") || "";
  // Pure in-page anchors (e.g. "jump to quoted post" while reading the full
  // topic) resolve to the current pathname below — bail before that so we
  // never touch them.
  if (rawHref.startsWith("#")) {
    return;
  }
  if (link.target && link.target !== "_self") {
    return;
  }
  if (link.hasAttribute("download")) {
    return;
  }
  if (
    link.closest(
      ".topic-list-item, .topic-preview-modal, .topic-preview-modal__scrubber-modal"
    )
  ) {
    return;
  }

  let url;
  try {
    url = new URL(link.href, window.location.origin);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) {
    return;
  }

  const match = matchTopicLink(url.pathname);
  if (!match) {
    return;
  }

  // Already reading this exact topic's full page — let core's own
  // click-track handle the in-page jump instead of layering a modal on top.
  const currentMatch = matchTopicLink(window.location.pathname);
  if (currentMatch && currentMatch.topicId === match.topicId) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const topic = { id: match.topicId, slug: match.slug };
  trackTopicVisit(topic);

  const capabilities = api.container.lookup("service:capabilities");
  triggerHaptic(capabilities, "open");

  api.container.lookup("service:modal").show(TopicPreviewModal, {
    model: { topic, postNumber: match.postNumber },
  });
}
