import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import type { Host } from "./host.ts";
import type { Repo } from "./repo.ts";

export type Installation = { id: number; account: string };
export type Issue = { number: number; title: string };

export type GitHub = {
  listInstallations(): Promise<Installation[]>;
  listRepos(installationId: number): Promise<Repo[]>;
  listLabeledIssues(installationId: number, repo: Repo, label: string): Promise<Issue[]>;
};

export function createGitHub(host: Host): GitHub {
  const auth = { appId: host.app_id, privateKey: readFileSync(host.private_key_path, "utf8") };
  const app = new Octokit({ authStrategy: createAppAuth, auth });
  const installations = new Map<number, Octokit>();

  function asInstallation(installationId: number): Octokit {
    let octokit = installations.get(installationId);
    if (!octokit) {
      octokit = new Octokit({ authStrategy: createAppAuth, auth: { ...auth, installationId } });
      installations.set(installationId, octokit);
    }
    return octokit;
  }

  return {
    async listInstallations() {
      const all = await app.paginate(app.apps.listInstallations);
      return all.map((installation) => ({
        id: installation.id,
        account: installation.account && "login" in installation.account ? installation.account.login : "",
      }));
    },
    async listRepos(installationId) {
      const octokit = asInstallation(installationId);
      const repos = await octokit.paginate(octokit.apps.listReposAccessibleToInstallation);
      return repos.map((repo) => ({ owner: repo.owner.login, name: repo.name }));
    },
    async listLabeledIssues(installationId, repo, label) {
      const octokit = asInstallation(installationId);
      const issues = await octokit.paginate(octokit.issues.listForRepo, { owner: repo.owner, repo: repo.name, labels: label, state: "open" });
      // The issues API also returns pull requests.
      return issues.filter((issue) => !issue.pull_request).map((issue) => ({ number: issue.number, title: issue.title }));
    },
  };
}
