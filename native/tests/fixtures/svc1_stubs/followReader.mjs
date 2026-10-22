export function readerProgram() { return globalThis.__svc1.readerProgram(); }

export class FollowReader {
  constructor(program, channel, out, hooks, options) {
    this.program = program;
    this.channel = channel;
    this.out = out;
    this.hooks = hooks;
    this.options = options;
    this.view = { state: 'starting', title: null, error: null };
    this.index = globalThis.__svc1.created('reader', this, [program, channel, out]);
  }
  start() { globalThis.__svc1.rec('reader.start', [this.index]); }
  stop() { globalThis.__svc1.rec('reader.stop', [this.index]); }
}
