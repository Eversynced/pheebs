/**
 * Drop a leading UTF-8 byte order mark, which JSON.parse and the TOML parser both reject.
 * Windows PowerShell 5.1 prepends one when piping to a native program and when saving with
 * `-Encoding UTF8`, so a hook payload or a settings file can carry it without anyone noticing.
 * Unstripped, a hook drops its event and `init` takes the settings file for malformed and
 * starts it fresh, discarding everything else in it.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
