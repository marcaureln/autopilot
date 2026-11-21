import { describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { RateLimited } from "../core/github.ts";
import type { PlannerResult } from "../core/planner-result.ts";
import { SecretsMissing } from "../core/builder.ts";
import type { FileChange } from "../core/risk.ts";
import { BOT, CLAIM_ID, FakeWorld, HOST, HOST_CONFIG, HOST_NAME, LOW_RISK_PLAN, OWNER } from "./fake-github.ts";

const TITLE = "Add CONTRIBUTING.md";

function specGates(world: FakeWorld, issue: number): string[] {
  return world.repo.commentBodies(issue).flatMap((body) => /^<!-- autopilot:spec gate=(\w+)/.exec(body)?.[1] ?? []);
}

describe("who may start a job", () => {
  for (const labeledBy of ["stranger", "contributor"]) {
    test(`an issue labeled by ${labeledBy}, who is not an owner, is ignored`, async () => {
      const world = new FakeWorld();
      const issue = world.repo.openIssue({ title: TITLE, labeledBy });
      await world.poll(3);
      assert.deepEqual(world.repo.labelsOf(issue), ["autopilot"]);
      assert.deepEqual(world.repo.commentBodies(issue), []);
      assert.deepEqual(world.planned, []);
    });
  }

  test("an issue labeled by an owner starts", async () => {
    const world = new FakeWorld();
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll();
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
    assert.deepEqual(world.planned, [issue]);
  });
});

describe("the claim", () => {
  // The host waits CLAIM_SETTLE_MS (3 s) for a competing claim. `mock.timers` does not reach the
  // `node:timers/promises` import in run.ts, so this test takes the real 3 s.
  test("a free issue gets a claim comment from the bot, then the job goes on", async () => {
    const world = new FakeWorld();
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER, claimed: false });
    await world.poll();
    const claims = world.repo.comments.filter((comment) => comment.issue === issue && comment.body.includes("autopilot:claim"));
    assert.deepEqual(claims.map((comment) => [comment.author, comment.body]), [[BOT, `<!-- autopilot:claim host=${CLAIM_ID} -->\nautopilot works on this issue.`]]);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
  });

  test("a claim that names this host, from an older version, is still this host's", async () => {
    const world = new FakeWorld();
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER, claimed: false });
    world.repo.addComment(issue, BOT, `<!-- autopilot:claim host=${HOST_NAME} -->\nautopilot host \`${HOST_NAME}\` works on this issue.`);
    await world.poll();
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
    assert.deepEqual(world.planned, [issue]);
  });

  test("an issue that another host claimed first is left alone", async () => {
    const world = new FakeWorld();
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER, claimed: false });
    world.repo.addComment(issue, BOT, "<!-- autopilot:claim host=other -->\nautopilot host `other` works on this issue.");
    await world.poll(2);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot"]);
    assert.deepEqual(world.repo.commentBodies(issue), []);
    assert.deepEqual(world.planned, []);
  });
});

describe("Plan gate, after the planner wrote the spec", () => {
  const rows: { name: string; plan: Partial<PlannerResult>; labels: string[]; gate: string; builds: boolean; checkbox: boolean }[] = [
    { name: "a low risk plan goes to the build", plan: {}, labels: ["autopilot", "autopilot:working"], gate: "go", builds: true, checkbox: false },
    { name: "a plan the planner rates high goes to the build", plan: { risk: "high" }, labels: ["autopilot", "autopilot:working"], gate: "go", builds: true, checkbox: false },
    {
      name: "a plan that touches a high risk path waits for approval",
      plan: { planned_files: [{ path: ".github/workflows/ci.yml", status: "modified" }] },
      labels: ["autopilot", "autopilot:awaiting-approval"],
      gate: "approval_required",
      builds: false,
      checkbox: true,
    },
    { name: "a plan that is too broad waits for approval", plan: { scope: "too_broad" }, labels: ["autopilot", "autopilot:awaiting-approval"], gate: "approval_required", builds: false, checkbox: true },
    {
      name: "a plan with questions waits for an answer",
      plan: { needs_info: true, questions: ["Which license?"] },
      labels: ["autopilot", "autopilot:needs-info"],
      gate: "needs_info",
      builds: false,
      checkbox: false,
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const world = new FakeWorld();
      world.script.plan = { ...LOW_RISK_PLAN, ...row.plan };
      const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
      await world.poll();
      assert.deepEqual(world.repo.labelsOf(issue), row.labels);
      assert.deepEqual(specGates(world, issue), [row.gate]);
      const spec = world.repo.commentBodies(issue)[0] ?? "";
      assert.equal(spec.includes("- [ ] Approve and build"), row.checkbox);
      assert.equal(spec.includes("Which license?"), row.plan.needs_info === true);
      await world.poll(2);
      assert.equal(world.repo.pulls.length, row.builds ? 1 : 0);
      assert.deepEqual(specGates(world, issue), [row.gate]);
    });
  }

  test("a failing planner blocks the issue and tells why", async () => {
    const world = new FakeWorld();
    world.script.planError = new Error("the model is down");
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll();
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
    const [message] = world.repo.commentBodies(issue);
    assert.match(message ?? "", /^autopilot stopped: .*the model is down/);
  });
});

describe("approval of a spec", () => {
  const rows: { name: string; ticks: string[]; builds: boolean }[] = [
    { name: "a tick by an owner starts the build", ticks: [OWNER], builds: true },
    { name: "a tick by a non-owner does not", ticks: ["stranger"], builds: false },
    { name: "a tick by an owner after an edit by a non-owner does not", ticks: ["stranger", OWNER], builds: false },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const world = new FakeWorld();
      world.script.plan = { ...LOW_RISK_PLAN, scope: "too_broad" };
      const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
      await world.poll(2);
      assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:awaiting-approval"]);
      for (const by of row.ticks) world.repo.tick(issue, by);
      await world.poll();
      assert.equal(world.repo.pulls.length, row.builds ? 1 : 0);
      assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", row.builds ? "autopilot:working" : "autopilot:awaiting-approval"]);
    });
  }

  test("an unticked spec keeps waiting", async () => {
    const world = new FakeWorld();
    world.script.plan = { ...LOW_RISK_PLAN, scope: "too_broad" };
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll(4);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:awaiting-approval"]);
    assert.equal(world.repo.pulls.length, 0);
  });
});

const PASSING_FILES: FileChange[] = [{ status: "modified", path: "src/a.ts", additions: 3, deletions: 1 }];

// Polls until the builder's pull request exists, then returns its number.
async function buildPull(world: FakeWorld, issue: number): Promise<number> {
  for (let polls = 0; polls < 5 && world.repo.pulls.length === 0; polls++) await world.poll();
  const pull = world.repo.pulls.find((candidate) => candidate.issue === issue);
  assert.ok(pull, "the builder opened a pull request");
  return pull.number;
}

describe("from the builder's pull request to the merge", () => {
  test("a low risk change with merge auto: the build, the checks, then the merge at the checked head", async () => {
    const world = new FakeWorld();
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    const pull = await buildPull(world, issue);
    assert.equal(world.repo.merges.length, 0);

    await world.poll();
    const head = world.repo.headOf(pull);
    assert.equal(head, "sha-1");
    assert.deepEqual(world.repo.statusStates("sha-1"), { lint: "success", test: "success" });
    assert.deepEqual(world.repo.merges.map(({ pull, sha, message }) => ({ pull, sha, message })), [{ pull, sha: "sha-1", message: `Fixes #${issue}` }]);
    assert.deepEqual(world.repo.reviewRequests, []);

    await world.poll();
    assert.deepEqual(world.repo.labelsOf(issue), [], "the merge closes the issue and the next poll removes the autopilot labels");
    assert.equal(world.repo.merges.length, 1);
  });

  const mergeGate = [
    { name: "merge auto and a low risk diff: merges", merge: "auto", files: PASSING_FILES, plannerRisk: "low", merged: true },
    { name: "merge manual: asks for a review", merge: "manual", files: PASSING_FILES, plannerRisk: "low", merged: false },
    { name: "the diff touches package.json: asks for a review", merge: "auto", files: [{ status: "modified", path: "package.json", additions: 1, deletions: 1 }], plannerRisk: "low", merged: false },
    { name: "the diff is larger than risk.max_diff_lines: asks for a review", merge: "auto", files: [{ status: "modified", path: "src/a.ts", additions: 600, deletions: 0 }], plannerRisk: "low", merged: false },
    { name: "the diff deletes a file: asks for a review", merge: "auto", files: [{ status: "deleted", path: "src/a.ts", additions: 0, deletions: 9 }], plannerRisk: "low", merged: false },
    { name: "the planner rated the risk high and an owner approved: asks for a review", merge: "auto", files: PASSING_FILES, plannerRisk: "high", merged: false },
  ] satisfies { name: string; merge: string; files: FileChange[]; plannerRisk: "low" | "high"; merged: boolean }[];
  for (const row of mergeGate) {
    test(`Merge gate, ${row.name}`, async () => {
      const world = new FakeWorld({ ...HOST_CONFIG, merge: row.merge });
      world.script.plan = { ...LOW_RISK_PLAN, risk: row.plannerRisk };
      const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
      if (row.plannerRisk === "high") {
        await world.poll();
        world.repo.tick(issue, OWNER);
      }
      const pull = await buildPull(world, issue);
      const opened = world.repo.pulls.find((candidate) => candidate.number === pull);
      assert.ok(opened);
      opened.files = row.files;
      await world.poll();
      assert.equal(world.repo.merges.length, row.merged ? 1 : 0);
      assert.deepEqual(world.repo.reviewRequests, row.merged ? [] : [{ pull, reviewers: [OWNER] }]);
      const waiting = world.repo.commentBodies(issue).filter((body) => body.includes("waits for a review"));
      assert.equal(waiting.length, row.merged ? 0 : 1);
      assert.deepEqual(world.repo.statusStates("sha-1"), { lint: "success", test: "success" });
      assert.ok(world.repo.labelsOf(issue).includes("autopilot:working") || row.merged);
    });
  }

  test("a review that waits is requested once, not on each poll", async () => {
    const world = new FakeWorld({ ...HOST_CONFIG, merge: "manual" });
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await buildPull(world, issue);
    await world.poll(4);
    assert.equal(world.repo.reviewRequests.length, 1);
    assert.equal(world.repo.commentBodies(issue).filter((body) => body.includes("waits for a review")).length, 1);
    assert.equal(world.checkRuns, 1);
  });

  test("a head that the host did not push, with passing checks, goes to a review and never merges", async () => {
    const world = new FakeWorld();
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll();
    world.repo.pushCommit("autopilot/1-add-contributing-md", "sha-human");
    const pull = world.repo.openPullFor("autopilot/1-add-contributing-md");
    await world.poll();
    assert.equal(world.repo.merges.length, 0);
    assert.deepEqual(world.repo.reviewRequests, [{ pull, reviewers: [OWNER] }]);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
  });
});

describe("failing checks", () => {
  test("a failing check starts a fix round that gets the output, then the fixed head merges", async () => {
    const world = new FakeWorld();
    world.script.failingRuns = [["test"]];
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    const pull = await buildPull(world, issue);

    await world.poll();
    assert.deepEqual(world.repo.statusStates("sha-1"), { lint: "success", test: "failure" });
    assert.equal(world.repo.merges.length, 0);
    assert.deepEqual(world.repo.branches.get("autopilot/1-add-contributing-md"), ["sha-1", "sha-2"]);
    const fix = world.builds.at(-1);
    assert.equal(fix?.kind, "fix");
    assert.deepEqual(fix?.kind === "fix" ? fix.failures : [], [{ check: "test", output: "test failed\n\nboom in test" }]);

    await world.poll();
    assert.deepEqual(world.repo.statusStates("sha-2"), { lint: "success", test: "success" });
    assert.deepEqual(world.repo.merges.map((merge) => [merge.pull, merge.sha]), [[pull, "sha-2"]]);
  });

  test("the same check failing twice in a row blocks the issue and shows the output", async () => {
    const world = new FakeWorld();
    world.script.failingRuns = [["test"], ["test"]];
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await buildPull(world, issue);
    await world.poll(2);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
    const [message] = world.repo.commentBodies(issue).slice(-1);
    assert.match(message ?? "", /^autopilot stopped: .*`test`.*boom in test/s);
    assert.equal(world.repo.merges.length, 0);
    assert.equal(world.builds.filter((mode) => mode.kind === "fix").length, 1);
    await world.poll(2);
    assert.equal(world.builds.filter((mode) => mode.kind === "fix").length, 1, "a blocked issue is not worked on again");
  });

  test("different checks failing each round block the issue after limits.fix_rounds", async () => {
    const world = new FakeWorld({ ...HOST_CONFIG, limits: { fix_rounds: 2 } });
    world.script.failingRuns = [["lint"], ["test"], ["lint"]];
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await buildPull(world, issue);
    await world.poll(3);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
    assert.equal(world.builds.filter((mode) => mode.kind === "fix").length, 2);
    assert.equal(world.repo.merges.length, 0);
  });

  test("a head pushed by someone else with failing checks blocks and is not fixed", async () => {
    const world = new FakeWorld();
    world.script.failingRuns = [["test"]];
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll();
    world.repo.pushCommit("autopilot/1-add-contributing-md", "sha-human");
    world.repo.openPullFor("autopilot/1-add-contributing-md");
    await world.poll();
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
    assert.match(world.repo.commentBodies(issue).at(-1) ?? "", /^autopilot stopped: Someone else pushed/);
    assert.deepEqual(world.builds, []);
    assert.equal(world.repo.merges.length, 0);
  });
});

describe("a repo with 1Password references", () => {
  const withSecrets = { ...HOST_CONFIG, secrets: { API_KEY: "op://autopilot/owner_app/API_KEY" } };
  const fileHost = { ...HOST, secrets: { app_key: "file:app-key", claude_token: "file:claude-token" } };
  const rows = [
    { name: "a host with 1Password runs the checks", host: HOST, config: withSecrets, blocked: false },
    { name: "a host without 1Password blocks the issue before the checks", host: fileHost, config: withSecrets, blocked: true },
    { name: "a host without 1Password runs a repo that has no secrets", host: fileHost, config: HOST_CONFIG, blocked: false },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const world = new FakeWorld(row.config, row.host);
      const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
      await buildPull(world, issue);
      await world.poll();
      assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", row.blocked ? "autopilot:blocked" : "autopilot:working"]);
      assert.equal(world.checkRuns, row.blocked ? 0 : 1);
      if (row.blocked) assert.match(world.repo.commentBodies(issue).at(-1) ?? "", /^autopilot stopped: .*no 1Password.*autopilot secrets set/s);
    });
  }
});

describe("verify.mode ci", () => {
  const ciConfig = { ...HOST_CONFIG, verify: { mode: "ci", required: ["build"], timeout_minutes: 10 } };

  test("the host runs no check, waits for the repo's CI, then merges on a green run", async () => {
    const world = new FakeWorld(ciConfig);
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await buildPull(world, issue);
    await world.poll(2);
    assert.equal(world.checkRuns, 0);
    assert.deepEqual(world.repo.statusStates("sha-1"), {});
    assert.equal(world.repo.merges.length, 0);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);

    world.repo.ciRun("sha-1", "build", "success");
    await world.poll();
    assert.deepEqual(world.repo.merges.map((merge) => merge.sha), ["sha-1"]);
    assert.equal(world.checkRuns, 0);
  });

  test("a CI that gives no result within verify.timeout_minutes blocks the issue", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      const world = new FakeWorld(ciConfig);
      const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
      await buildPull(world, issue);
      await world.poll();
      mock.timers.tick(9 * 60 * 1000);
      await world.poll();
      assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"], "still waiting at 9 minutes");
      mock.timers.tick(2 * 60 * 1000);
      await world.poll();
      assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
      assert.match(world.repo.commentBodies(issue).at(-1) ?? "", /^autopilot stopped: .*`build`.*10 minutes/s);
      assert.equal(world.repo.merges.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  test("a failed CI job starts a fix round with the CI output", async () => {
    const world = new FakeWorld(ciConfig);
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await buildPull(world, issue);
    world.repo.ciRun("sha-1", "build", "failure");
    await world.poll();
    const fix = world.builds.at(-1);
    assert.equal(fix?.kind, "fix");
    assert.deepEqual(fix?.kind === "fix" ? fix.failures : [], [{ check: "build", output: "CI log of build on sha-1" }]);
    assert.equal(world.repo.merges.length, 0);
  });
});

describe("a builder that fails", () => {
  test("a plain error blocks the issue and the agent does not run again", async () => {
    const world = new FakeWorld();
    world.script.buildError = new Error("the container did not start");
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll(3);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
    assert.match(world.repo.commentBodies(issue).at(-1) ?? "", /^autopilot stopped: The build failed: the container did not start\./);
    assert.equal(world.builds.length, 1);
  });
});

describe("a builder that needs secrets", () => {
  test("the issue moves to needs-info with a comment that names them, and a new spec follows the owner's reply", async () => {
    const world = new FakeWorld();
    world.script.buildError = new SecretsMissing(["API_KEY", "DB_URL"]);
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll(2);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:needs-info"]);
    const [spec, ask] = world.repo.commentBodies(issue);
    assert.match(ask ?? "", /`API_KEY`, `DB_URL`/);
    assert.equal(world.repo.pulls.length, 0);

    await world.poll(2);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:needs-info"], "no reply yet");
    assert.equal(world.repo.commentBodies(issue).length, 2);

    world.script.buildError = undefined;
    world.repo.addComment(issue, OWNER, "I set the secrets.");
    await world.poll();
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
    const specs = world.repo.comments.filter((comment) => comment.issue === issue && comment.body.startsWith("<!-- autopilot:spec"));
    assert.equal(specs.length, 2, "the planner wrote a new spec");
    assert.equal(world.repo.isHidden(specs[0]?.id ?? 0), true, "the old spec is hidden");
    assert.equal(spec?.startsWith("<!-- autopilot:spec"), true);
  });
});

describe("a repo with no config", () => {
  async function onboarded(world: FakeWorld): Promise<{ issue: number; pull: number }> {
    world.repo.config = undefined;
    const issue = world.repo.openIssue({ title: "A 2D platformer in Godot 4", labeledBy: OWNER });
    await world.poll();
    const pull = world.repo.pulls.find((candidate) => candidate.head.ref === "autopilot/onboarding");
    assert.ok(pull, "the host opened the onboarding pull request");
    return { issue, pull: pull.number };
  }

  test("an owner's issue gets an onboarding pull request and a comment that links it", async () => {
    const world = new FakeWorld();
    const { issue, pull } = await onboarded(world);
    assert.deepEqual(world.onboarded, [issue]);
    assert.equal(world.repo.pulls[pull - 1]?.title, "Set up autopilot");
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
    const [comment] = world.repo.commentBodies(issue);
    assert.match(comment ?? "", new RegExp(`Pull request #${pull} sets it up`));
    assert.deepEqual(world.planned, []);
  });

  test("while the onboarding pull request is open, the issue waits", async () => {
    const world = new FakeWorld();
    const { issue } = await onboarded(world);
    await world.poll(2);
    assert.deepEqual(world.onboarded, [issue]);
    assert.equal(world.repo.pulls.length, 1);
    assert.equal(world.repo.commentBodies(issue).length, 1);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
    assert.deepEqual(world.planned, []);
  });

  test("when an owner merges the onboarding pull request, the spec of the same issue starts", async () => {
    const world = new FakeWorld();
    const { issue, pull } = await onboarded(world);
    world.repo.finishPull(pull, "merged");
    world.repo.config = HOST_CONFIG;
    await world.poll();
    assert.deepEqual(world.planned, [issue]);
    assert.deepEqual(specGates(world, issue), ["go"]);
    assert.deepEqual(world.onboarded, [issue]);
  });

  test("when the onboarding pull request is closed without a merge, the issue is blocked", async () => {
    const world = new FakeWorld();
    const { issue, pull } = await onboarded(world);
    world.repo.finishPull(pull, "closed");
    await world.poll(2);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
    assert.match(world.repo.commentBodies(issue).at(-1) ?? "", new RegExp(`^autopilot stopped: The onboarding pull request #${pull} was cl\u200bosed without a merge`), "the comment breaks the closing keyword");
    assert.deepEqual(world.onboarded, [issue]);
  });

  test("a failing onboarding blocks the issue and tells why", async () => {
    const world = new FakeWorld();
    world.repo.config = undefined;
    world.script.onboardError = new Error("the onboarding agent wrote no .autopilot/result.json");
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll();
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
    assert.match(world.repo.commentBodies(issue)[0] ?? "", /^autopilot stopped: The onboarding failed: the onboarding agent wrote no/);
    assert.equal(world.repo.pulls.length, 0);
  });

  test("two issues that start together open one onboarding pull request", async () => {
    const world = new FakeWorld(HOST_CONFIG, { ...HOST, concurrency: 2 });
    world.repo.config = undefined;
    const first = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    const second = world.repo.openIssue({ title: "Add a README", labeledBy: OWNER });
    await world.poll(2);
    assert.deepEqual(world.onboarded, [first]);
    assert.equal(world.repo.pulls.length, 1);
    assert.match(world.repo.commentBodies(second)[0] ?? "", /Pull request #1 sets it up/, "the second issue waits for the same pull request");
    assert.equal(world.repo.commentBodies(second).length, 1);
  });

  test("after a crash between the pull request and its comment, the next poll posts the comment once", async () => {
    const world = new FakeWorld();
    world.repo.config = undefined;
    world.repo.pushCommit("autopilot/onboarding", "sha-before-crash");
    const pull = world.repo.openPullFor("autopilot/onboarding");
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll(3);
    assert.deepEqual(world.onboarded, [], "no second onboarding");
    assert.equal(world.repo.pulls.length, 1);
    assert.equal(world.repo.commentBodies(issue).length, 1);
    assert.match(world.repo.commentBodies(issue)[0] ?? "", new RegExp(`Pull request #${pull} sets it up`));
  });

  test("an issue that another host claimed is not onboarded by this host", async () => {
    const world = new FakeWorld();
    world.repo.config = undefined;
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER, claimed: false });
    world.repo.addComment(issue, BOT, "<!-- autopilot:claim host=other -->\nautopilot host `other` works on this issue.");
    await world.poll(2);
    assert.deepEqual(world.onboarded, []);
    assert.equal(world.repo.pulls.length, 0);
  });

  test("an empty repo blocks the issue and says to push a first commit", async () => {
    const world = new FakeWorld();
    world.repo.config = undefined;
    world.repo.empty = true;
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll();
    assert.deepEqual(world.onboarded, []);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:blocked"]);
    assert.match(world.repo.commentBodies(issue)[0] ?? "", /^autopilot stopped: This repo has no commits.* Push one commit .* for example a README/);
  });

  test("when another host opens the onboarding pull request first, the issue waits for it", async () => {
    const world = new FakeWorld();
    world.repo.config = undefined;
    world.script.onboardRace = true;
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll(2);
    assert.deepEqual(world.onboarded, [issue]);
    assert.equal(world.repo.pulls.length, 1);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
    assert.match(world.repo.commentBodies(issue)[0] ?? "", /Pull request #1 sets it up/, "the issue links the pull request of the other host");
    assert.equal(world.repo.commentBodies(issue).length, 1);
  });

  test("an issue labeled by a non-owner is still ignored", async () => {
    const world = new FakeWorld();
    world.repo.config = undefined;
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: "stranger" });
    await world.poll(2);
    assert.deepEqual(world.onboarded, []);
    assert.equal(world.repo.pulls.length, 0);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot"]);
  });
});

describe("the poll", () => {
  const ownerHost = { ...HOST, allow: [OWNER], concurrency: 2 };

  test("one search finds the labeled issues in two repos of the owner", async () => {
    const world = new FakeWorld(HOST_CONFIG, ownerHost);
    const api = world.addRepo({ owner: OWNER, name: "api" });
    world.addRepo({ owner: OWNER, name: "docs" });
    const appIssue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    const apiIssue = api.openIssue({ title: "Add a README", labeledBy: OWNER });
    await world.poll();
    assert.deepEqual(world.repo.labelsOf(appIssue), ["autopilot", "autopilot:working"]);
    assert.deepEqual(api.labelsOf(apiIssue), ["autopilot", "autopilot:working"]);
    assert.equal(world.searches, 2, "one search for open issues and one for closed issues, for any number of repos");
  });

  test("a public repo of the owner where the App is not installed is ignored", async () => {
    const world = new FakeWorld(HOST_CONFIG, ownerHost);
    const outside = world.addRepo({ owner: OWNER, name: "public" }, { installed: false });
    const issue = outside.openIssue({ title: TITLE, labeledBy: OWNER });
    const closed = outside.openIssue({ title: "Add a README", labeledBy: OWNER });
    const found = outside.issues.get(closed);
    if (found) found.open = false;
    await world.poll(2);
    assert.deepEqual(outside.labelsOf(issue), ["autopilot"]);
    assert.deepEqual(outside.labelsOf(closed), ["autopilot"]);
    assert.deepEqual(outside.commentBodies(issue), []);
    assert.deepEqual(world.planned, []);
  });

  test("a closed issue in another repo of the owner loses its autopilot labels", async () => {
    const world = new FakeWorld(HOST_CONFIG, ownerHost);
    const api = world.addRepo({ owner: OWNER, name: "api" });
    const issue = api.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll();
    const found = api.issues.get(issue);
    if (found) found.open = false;
    await world.poll();
    assert.deepEqual(api.labelsOf(issue), []);
    assert.ok(world.logs.includes(`${OWNER}/api#${issue}: closed, autopilot labels removed`));
  });

  test("after a rate limit, the loop logs one line and sends no request until the reset", async () => {
    const world = new FakeWorld();
    world.nextSearchRateLimit = new RateLimited(new Date(Date.now() + 100), 403, {});
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll(2);
    assert.equal(world.searches, 1);
    assert.deepEqual(world.planned, []);
    const limits = world.logs.filter((line) => line.includes("rate limit"));
    assert.equal(limits.length, 1);
    assert.match(limits[0] ?? "", /^rate limit reached, waiting until \d\d:\d\d$/);
    assert.ok(!world.logs.some((line) => line.includes("error")));
    await sleep(150);
    await world.poll();
    assert.deepEqual(world.planned, [issue]);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
  });
});
