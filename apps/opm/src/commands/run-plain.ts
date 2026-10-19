/**
 * `plainLine`, for text a project's files chose: one line, with no escape or
 * control character, nothing cut. Loaded when a message needs it, because
 * starting a script imports nothing but Node and this directory (ADR 0047,
 * `run-load.test.ts`); listing scripts and explaining a failure are the rare
 * paths.
 */
export async function plain(): Promise<(text: string) => string> {
  return (await import('@openpacker/canonical')).plainLine;
}

/**
 * A path quoted in a message. A directory a cloned repository holds may be named
 * with a line feed or an escape, and a message that is a list keeps its own line
 * feeds, so what it quotes is made one plain line where it is quoted.
 */
export async function quoted(path: string): Promise<string> {
  return (await plain())(path);
}
