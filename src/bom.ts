/**
 * Drop a leading UTF-8 byte order mark, which JSON.parse and the TOML parser both reject. Hook
 * stdin piped through Windows PowerShell can carry one, and so can a settings file it saved: see
 * the 2026-10-05 BOM entry in docs/spike-findings-ledger.md.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
