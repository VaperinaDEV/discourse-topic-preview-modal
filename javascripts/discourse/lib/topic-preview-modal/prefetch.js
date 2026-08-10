import { ajax } from "discourse/lib/ajax";
import PreloadStore from "discourse/lib/preload-store";

// Shared across every topic-list row on the page: caps concurrent topic
// prefetch requests so a fast scroll doesn't fire dozens of topic JSON
// fetches at once. Configurable via the theme's "max_concurrent_prefetches"
// setting.

function createPrefetchQueue(maxConcurrent) {
  const pending = [];
  const activeIds = new Set();

  function drain() {
    while (activeIds.size < maxConcurrent && pending.length) {
      const { id, task } = pending.shift();
      activeIds.add(id);
      Promise.resolve()
        .then(task)
        .finally(() => {
          activeIds.delete(id);
          drain();
        });
    }
  }

  return {
    schedule(id, task) {
      if (activeIds.has(id) || pending.some((item) => item.id === id)) {
        return;
      }
      pending.push({ id, task });
      drain();
    },
    cancel(id) {
      const index = pending.findIndex((item) => item.id === id);
      if (index !== -1) {
        pending.splice(index, 1);
      }
      // Active in-flight requests cannot be aborted from here;
      // discardPrefetch() removes the result from PreloadStore instead.
    },
  };
}

const prefetchQueue = createPrefetchQueue(settings.max_concurrent_prefetches);

// Rolling-window safety net: once "max_prefetches_per_minute" prefetches
// have fired in the last 60s, further scroll-triggered prefetches are
// skipped until the window rolls forward (rows still open fine on click,
// they just load like a normal modal instead of feeling instant). This
// guards against a fast-scroll burst without permanently disabling
// prefetch for the rest of the page session. 0 = unlimited.
const PREFETCH_BUDGET_WINDOW_MS = 60 * 1000;
let prefetchTimestamps = [];

function pruneOldPrefetchTimestamps() {
  const cutoff = Date.now() - PREFETCH_BUDGET_WINDOW_MS;
  while (prefetchTimestamps.length && prefetchTimestamps[0] < cutoff) {
    prefetchTimestamps.shift();
  }
}

export function buildTopicPreviewUrl(topic) {
  const lastRead = topic.last_read_post_number ?? 0;
  const highest = topic.highest_post_number ?? 1;
  const initialPostNumber = Math.max(1, Math.min(lastRead + 1, highest));
  return initialPostNumber > 1
    ? `/t/${topic.id}/${initialPostNumber}.json`
    : `/t/${topic.id}.json`;
}

// Intentionally NOT the core `topic_${id}` key. Writing there would leak our
// last_read+1-scoped preview JSON into a real topic-route navigation.
// Private namespace ensures only the preview-modal path can see it.
function prefetchStoreKey(topicId) {
  return `topic-preview-modal:prefetch:${topicId}`;
}

// Prefetch does NOT send track_visit — only content is loaded early.
// trackTopicVisit() marks the visit only when the preview is actually opened
// (see the topic-list-item-click behavior transformer).
export function schedulePrefetch(topic) {
  if (!topic?.id || !settings.enable_prefetch) {
    return;
  }

  const budget = settings.max_prefetches_per_minute;
  if (budget > 0) {
    pruneOldPrefetchTimestamps();
    if (prefetchTimestamps.length >= budget) {
      return;
    }
  }

  prefetchQueue.schedule(topic.id, () => {
    prefetchTimestamps.push(Date.now());
    return PreloadStore.store(
      prefetchStoreKey(topic.id),
      ajax(buildTopicPreviewUrl(topic)).catch(() => {
        // let a future schedulePrefetch() call for this topic retry
      })
    );
  });
}

export function cancelPrefetch(topicId) {
  if (!topicId) {
    return;
  }
  prefetchQueue.cancel(topicId);
}

// When a topic leaves the viewport (still pending) or is no longer needed,
// drop the stored prefetch so we only keep data for relevant topics.
export function discardPrefetch(topicId) {
  if (!topicId) {
    return;
  }
  cancelPrefetch(topicId);
  try {
    PreloadStore.getAndRemove?.(prefetchStoreKey(topicId), () =>
      Promise.resolve(null)
    );
  } catch {
    // ignore API shape changes
  }
}

// On open, move the (possibly still pending) prefetch promise from our
// private key to the core `topic_${id}` key that the modal's loadTopic()
// expects. Synchronous: do not await the network — the modal opens with its
// own spinner and Topic.find() will wait on the same promise via
// PreloadStore.
export function promotePrefetch(topic) {
  if (!topic?.id) {
    return;
  }
  try {
    const key = prefetchStoreKey(topic.id);
    const prefetched = PreloadStore.get?.(key);
    if (prefetched != null) {
      PreloadStore.remove?.(key);
      PreloadStore.store(`topic_${topic.id}`, prefetched);
    }
  } catch {
    // best-effort — modal falls back to a fresh load
  }
}

// Server only increments view count on requests carrying track_visit.
export function trackTopicVisit(topic) {
  if (!topic?.id) {
    return;
  }
  ajax(buildTopicPreviewUrl(topic), {
    type: "HEAD",
    dataType: "text",
    data: { track_visit: true },
  }).catch(() => {});
}
