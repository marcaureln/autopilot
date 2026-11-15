import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { AllowEntry } from "./allow.ts";
import type { Host } from "./host.ts";
import type { Repo } from "./repo.ts";

export type Issue = { number: number; title: string };

export type GitHub = {
  findInstallation(entry: AllowEntry): Promise<number | undefined>;
  listRepos(installationId: number, owner: string): Promise<Repo[]>;
  listLabeledIssues(installationId: number, repo: Repo, label: string): Promise<Issue[]>;
};

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}

// A 304 answer to a conditional request does not count against the rate limit, so an unchanged poll is free.
function cacheGetsByEtag(octokit: Octokit): Octokit {
  const cache = new Map<string, { etag: string; response: Awaited<ReturnType<Octokit["request"]>> }>();
  octokit.hook.wrap("request", async (request, options) => {
    if (options.method !== "GET") return request(options);
    const key = octokit.request.endpoint.parse(options).url;
    const cached = cache.get(key);
    if (cached) options.headers = { ...options.headers, "if-none-match": cached.etag };
    try {
      const response = await request(options);
      if (response.headers.etag) cache.set(key, { etag: response.headers.etag, response });
      return response;
    } catch (error) {
      if (cached && hasStatus(error, 304)) return cached.response;
      throw error;
    }
  });
  return octokit;
}

export function createGitHub(host: Host): GitHub {
  const auth = { appId: host.app_id, privateKey: readFileSync(host.private_key_path, "utf8") };
  const app = new Octokit({ authStrategy: createAppAuth, auth, log: quiet });
  const clients = new Map<number, Octokit>();
  const installationIds = new Map<string, number>();

  function asInstallation(installationId: number): Octokit {
    let octokit = clients.get(installationId);
    if (!octokit) {
      octokit = cacheGetsByEtag(new Octokit({ authStrategy: createAppAuth, auth: { ...auth, installationId }, log: quiet }));
      clients.set(installationId, octokit);
    }
    return octokit;
  }

  return {
    async findInstallation(entry) {
      const key = entry.repo ? `${entry.owner}/${entry.repo}` : entry.owner;
      const known = installationIds.get(key);
      if (known !== undefined) return known;
      try {
        const { data } = entry.repo
          ? await app.apps.getRepoInstallation({ owner: entry.owner, repo: entry.repo })
          : await app.apps.getUserInstallation({ username: entry.owner });
        installationIds.set(key, data.id);
        return data.id;
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
    async listRepos(installationId, owner) {
      const octokit = asInstallation(installationId);
      const repos = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation, { per_page: 100 });
      return repos.filter((repo) => repo.owner.login === owner).map((repo) => ({ owner: repo.owner.login, name: repo.name }));
    },
    async listLabeledIssues(installationId, repo, label) {
      const octokit = asInstallation(installationId);
      const issues = await octokit.paginate(octokit.issues.listForRepo, { owner: repo.owner, repo: repo.name, labels: label, state: "open", per_page: 100 });
      // The issues API also returns pull requests.
      return issues.filter((issue) => !issue.pull_request).map((issue) => ({ number: issue.number, title: issue.title }));
    },
  };
}
