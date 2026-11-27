// Preloaded into a spawned CLI so a report that reads the clock gives the same bytes every run.
const FIXED = Date.parse(process.env.PHEEBS_TEST_NOW ?? "");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED);
  }
  static now() {
    return FIXED;
  }
};
