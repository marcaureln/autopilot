# Demo video

The setup video has seven parts. VHS renders four terminal parts from tapes. You record three browser parts by hand. ffmpeg joins them.

## Terminal parts

Each tape writes a GIF and an MP4 to `docs/demo/out/`. That folder is not tracked by git. All tapes use the same theme, font size, width and height.

| Tape                              | What it shows                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [install.tape](install.tape)      | The install line of the README, then `autopilot --help`.                                                                                                       |
| [setup.tape](setup.tape)          | `autopilot setup` on a machine that is already set up. Each step says "already done" and nothing changes. The Claude token is never typed and never printed.   |
| [issue.tape](issue.tape)          | `gh issue create` with the `autopilot` label on a test repo, then `autopilot logs` after the host claims the issue.                                            |
| [status.tape](status.tape)        | `autopilot hosts`, `autopilot watch` and `autopilot status`.                                                                                                   |

### Render

Install [VHS](https://github.com/charmbracelet/vhs). Run each command from the root of the repo:

```sh
vhs docs/demo/install.tape
vhs docs/demo/setup.tape
vhs docs/demo/issue.tape
vhs docs/demo/status.tape
```

Check these points before you render:

- `install.tape` runs the real install line. The script writes only to `~/.local` and skips a release it already has. Use a clean machine to show the full download.
- `setup.tape` and `status.tape` need a machine with a host already set up.
- `issue.tape` creates a real issue. Replace `<owner>/autopilot-sandbox` in the `Env REPO` line with a test repo that the host watches. The tape hides a 75 second wait, so the host has time to claim the issue.
- `setup.tape` waits for the prompts of the wizard (GitHub App, App ID, accounts, "Onboard a repo now?"). If a prompt does not appear, `Wait` stops after its timeout. Change the `Wait` lines to match your machine.

## Browser parts

Record these parts by hand, for example with the screen recorder of your OS. Use a 16:9 window.

1. **Create the App.** Run `autopilot app create` (or reach this step in `autopilot setup`), then click through the GitHub page that creates the App.
2. **Install the App on All repositories.** Open the install page that autopilot prints. Choose **All repositories**, then click **Install**.
3. **Tick the approval box.** Open the issue when the label is `autopilot:awaiting-approval`. Read the spec, then tick **Approve and build**.

## Join the parts

Name the parts in the order of the video. Use the MP4 files for the terminal parts.

| File                | Part                              |
| ------------------- | --------------------------------- |
| `01-create-app.mp4` | Browser: create the App           |
| `02-install.mp4`    | `out/install.mp4`                 |
| `03-setup.mp4`      | `out/setup.mp4`                   |
| `04-app-repos.mp4`  | Browser: install on All repositories |
| `05-issue.mp4`      | `out/issue.mp4`                   |
| `06-approve.mp4`    | Browser: tick the approval box    |
| `07-status.mp4`     | `out/status.mp4`                  |

Put the files in one folder. The parts can differ in size and frame rate, so first convert each part to 1280x720 at 30 frames per second, with no audio:

```sh
mkdir -p norm
for f in 0*.mp4; do
  ffmpeg -i "$f" -an \
    -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" \
    -c:v libx264 -crf 18 "norm/$f"
done
```

Write the list of the parts in `parts.txt`:

```text
file 'norm/01-create-app.mp4'
file 'norm/02-install.mp4'
file 'norm/03-setup.mp4'
file 'norm/04-app-repos.mp4'
file 'norm/05-issue.mp4'
file 'norm/06-approve.mp4'
file 'norm/07-status.mp4'
```

Join them. The parts now have the same format, so ffmpeg copies the streams and does not encode again:

```sh
ffmpeg -f concat -safe 0 -i parts.txt -c copy setup-video.mp4
```
