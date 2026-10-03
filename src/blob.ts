import { createHash } from "node:crypto";

/** The SHA git assigns to a file's content (`git hash-object`); GitHub's tree API reports the same value. */
export function gitBlobSha(content: string | Buffer): string {
  const buf = typeof content === "string" ? Buffer.from(content) : content;
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export const short = (sha: string) => sha.slice(0, 7);
