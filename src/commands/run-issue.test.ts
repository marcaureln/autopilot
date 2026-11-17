import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PlannerResult } from "../core/planner.ts";
import { BOT, FakeWorld, HOST_NAME, LOW_RISK_PLAN, OWNER } from "./fake-github.ts";

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
    assert.deepEqual(claims.map((comment) => [comment.author, comment.body.includes(`host=${HOST_NAME}`)]), [[BOT, true]]);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:working"]);
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

describe("Gate 1, after the planner wrote the spec", () => {
  const rows: { name: string; plan: Partial<PlannerResult>; labels: string[]; gate: string; builds: boolean; checkbox: boolean }[] = [
    { name: "a low risk plan goes to the build", plan: {}, labels: ["autopilot", "autopilot:working"], gate: "go", builds: true, checkbox: false },
    { name: "a plan the planner rates high waits for approval", plan: { risk: "high" }, labels: ["autopilot", "autopilot:awaiting-approval"], gate: "approval_required", builds: false, checkbox: true },
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

describe("approval of a high risk spec", () => {
  const rows: { name: string; ticks: string[]; builds: boolean }[] = [
    { name: "a tick by an owner starts the build", ticks: [OWNER], builds: true },
    { name: "a tick by a non-owner does not", ticks: ["stranger"], builds: false },
    { name: "a tick by an owner after an edit by a non-owner does not", ticks: ["stranger", OWNER], builds: false },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const world = new FakeWorld();
      world.script.plan = { ...LOW_RISK_PLAN, risk: "high" };
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
    world.script.plan = { ...LOW_RISK_PLAN, risk: "high" };
    const issue = world.repo.openIssue({ title: TITLE, labeledBy: OWNER });
    await world.poll(4);
    assert.deepEqual(world.repo.labelsOf(issue), ["autopilot", "autopilot:awaiting-approval"]);
    assert.equal(world.repo.pulls.length, 0);
  });
});
