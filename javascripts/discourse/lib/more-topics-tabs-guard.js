// Core's <MoreTopics> stores its state in the singleton service:more-topics-tabs
// and writes it from a render modifier (`syncTopic`), while its own template
// reads `selectedTab`/`tabs` from that same service during render. Fine with
// one instance. With two (e.g. the modal's core <Nested> mounts a second
// <MoreTopics> on top of the page's own nested view's), each instance's
// modifier stomps the other's tracked state mid-render, `selectedTab` flips
// between topics, and the renderer never settles -> "infinite rendering
// invalidation detected".
//
// Fix: make the singleton first-writer-wins while more than one client is
// alive. The first mounted <MoreTopics> keeps it; a second is a no-op until
// the first tears down. The modal hides its own `.more-topics__container`
// anyway (see common.scss), so nothing visible is lost.

let installed = false;

export function installMoreTopicsTabsGuard(owner) {
  if (installed) {
    return;
  }

  const service = owner?.lookup?.("service:more-topics-tabs");
  if (!service || typeof service.setup !== "function") {
    return; // older/renamed core: nothing to guard
  }

  installed = true;

  const originalSetup = service.setup.bind(service);
  const originalTeardown = service.teardown.bind(service);
  let activeClients = 0;

  service.setup = function (topic) {
    activeClients += 1;
    if (activeClients === 1) {
      originalSetup(topic);
    }
  };

  service.teardown = function () {
    activeClients = Math.max(0, activeClients - 1);
    if (activeClients === 0) {
      originalTeardown();
    }
  };
}
