// inboxPath / LOCAL_CHANNEL 是纯的,取真身的;FollowInbox 换成垫片(世界按脚本喂消息、记启停)
const real = await import(`${globalThis.__svc1Dist}/followInbox.js`);
export const LOCAL_CHANNEL = real.LOCAL_CHANNEL;
export const inboxPath = real.inboxPath;

export class FollowInbox {
  constructor(path, hooks, options) {
    this.path = path;
    this.hooks = hooks;
    this.options = options;
    this.watching = false;
    this.lastAt = null;
    this.received = 0;
    this.error = null;
    this.index = globalThis.__svc1.created('inbox', this, [path]);
  }
  start() { this.watching = true; globalThis.__svc1.rec('inbox.start', [this.index]); }
  stop() { this.watching = false; globalThis.__svc1.rec('inbox.stop', [this.index]); }
  poll() { globalThis.__svc1.rec('inbox.poll', [this.index]); }
}
