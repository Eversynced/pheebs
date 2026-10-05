// Run `fn` as if on another OS. Only `process.platform` changes, so this covers the branches
// that read it, not the behavior of the OS itself.
export function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}
