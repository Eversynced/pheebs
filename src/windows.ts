import { win32 } from "node:path";

// Windows resolves a bare program name in the current folder before PATH, and the current folder
// is usually a repo the developer cloned, so a planted `whoami.exe` there would run instead.
export function systemExe(name: string): string {
  return win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}
