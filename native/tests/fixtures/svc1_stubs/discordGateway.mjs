export class DiscordGateway {
  constructor(token, hooks, options) {
    this.token = token;
    this.hooks = hooks;
    this.options = options;
    this.bot = null;
    this.guildsSeen = false;
    this.channels = new Set();
    this.index = globalThis.__svc1.created('gateway', this, [token]);
  }
  start() { globalThis.__svc1.rec('gateway.start', [this.index]); }
  stop() { globalThis.__svc1.rec('gateway.stop', [this.index]); }
}
