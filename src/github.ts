import { execFileSync } from "node:child_process";

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export interface Resolved {
  /** Commit SHA the ref points at. */
  sha: string;
  treeSha: string;
  /** The ref that was resolved (the default branch when none was given). */
  ref: string;
  kind: "branch" | "tag" | "sha";
}

export interface Comparison {
  status: "identical" | "ahead" | "behind" | "diverged";
  aheadBy: number;
  behindBy: number;
}

/** Everything the checks need from GitHub; tests swap in a fake. */
export interface Github {
  resolve(repo: string, ref?: string): Promise<Resolved>;
  tree(repo: string, treeSha: string): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  blob(repo: string, sha: string): Promise<Buffer>;
  /** How `head` relates to `base`; null when GitHub has never seen `head`. */
  compare(repo: string, base: string, head: string): Promise<Comparison | null>;
  commitExists(repo: string, sha: string): Promise<boolean>;
  openPulls(repo: string): Promise<{ number: number; title: string; head: string }[]>;
  branches(repo: string): Promise<{ name: string; sha: string }[]>;
}

export class GithubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** GITHUB_TOKEN / GH_TOKEN, else the GitHub CLI's login, else anonymous (public repos only). */
export function findToken(): string | undefined {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export class GithubApi implements Github {
  private cache = new Map<string, Promise<unknown>>();

  constructor(private token?: string, private apiUrl = "https://api.github.com") {}

  private async request(path: string): Promise<{ json: any; link: string | null }> {
    const res = await fetch(this.apiUrl + path, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "deploy-drift",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = (() => { try { return JSON.parse(body).message; } catch { return body.slice(0, 200); } })();
      throw new GithubError(res.status, `GitHub ${res.status} for ${path}: ${msg}`);
    }
    return { json: await res.json(), link: res.headers.get("link") };
  }

  private memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) {
      const p = fn();
      p.catch(() => this.cache.delete(key)); // don't cache failures
      this.cache.set(key, p);
    }
    return this.cache.get(key) as Promise<T>;
  }

  private async paged<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path + (path.includes("?") ? "&" : "?") + "per_page=100";
    while (next) {
      const { json, link } = await this.request(next);
      out.push(...(json as T[]));
      const m = link?.match(/<([^>]+)>;\s*rel="next"/);
      next = m ? m[1].replace(this.apiUrl, "") : null;
    }
    return out;
  }

  private defaultBranch(repo: string): Promise<string> {
    return this.memo(`default:${repo}`, async () => (await this.request(`/repos/${repo}`)).json.default_branch);
  }

  resolve(repo: string, ref?: string): Promise<Resolved> {
    return this.memo(`resolve:${repo}:${ref ?? ""}`, async () => {
      const name = ref ?? (await this.defaultBranch(repo));
      const { json } = await this.request(`/repos/${repo}/commits/${encodeURIComponent(name)}`);
      let kind: Resolved["kind"] = /^[0-9a-f]{7,40}$/.test(name) ? "sha" : "tag";
      if (kind !== "sha") {
        try {
          await this.request(`/repos/${repo}/branches/${encodeURIComponent(name)}`);
          kind = "branch";
        } catch (e) {
          if (!(e instanceof GithubError && e.status === 404)) throw e;
        }
      }
      return { sha: json.sha, treeSha: json.commit.tree.sha, ref: name, kind };
    });
  }

  tree(repo: string, treeSha: string) {
    return this.memo(`tree:${repo}:${treeSha}`, async () => {
      const { json } = await this.request(`/repos/${repo}/git/trees/${treeSha}?recursive=1`);
      return { entries: json.tree as TreeEntry[], truncated: Boolean(json.truncated) };
    });
  }

  blob(repo: string, sha: string) {
    return this.memo(`blob:${repo}:${sha}`, async () => {
      const { json } = await this.request(`/repos/${repo}/git/blobs/${sha}`);
      return Buffer.from(json.content, json.encoding === "base64" ? "base64" : "utf8");
    });
  }

  compare(repo: string, base: string, head: string) {
    return this.memo(`compare:${repo}:${base}:${head}`, async () => {
      try {
        const { json } = await this.request(`/repos/${repo}/compare/${base}...${head}`);
        return { status: json.status, aheadBy: json.ahead_by, behindBy: json.behind_by } as Comparison;
      } catch (e) {
        if (e instanceof GithubError && (e.status === 404 || e.status === 422)) return null;
        throw e;
      }
    });
  }

  commitExists(repo: string, sha: string) {
    return this.memo(`exists:${repo}:${sha}`, async () => {
      try {
        await this.request(`/repos/${repo}/commits/${sha}`);
        return true;
      } catch (e) {
        if (e instanceof GithubError && (e.status === 404 || e.status === 422)) return false;
        throw e;
      }
    });
  }

  async openPulls(repo: string) {
    const pulls = await this.paged<any>(`/repos/${repo}/pulls?state=open`);
    return pulls.map((p) => ({ number: p.number, title: p.title, head: p.head?.ref ?? "" }));
  }

  async branches(repo: string) {
    const list = await this.paged<any>(`/repos/${repo}/branches`);
    return list.map((b) => ({ name: b.name, sha: b.commit.sha }));
  }
}
