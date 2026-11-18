# Shared settings: keep the Output and Set lines below the same in every tape
# (install, setup, issue, status), except the Output names. Each tape repeats
# them because VHS has no include for settings.
Output docs/demo/out/setup.gif
Output docs/demo/out/setup.mp4

Require autopilot

Set Shell "bash"
Set FontSize 22
Set Width 1280
Set Height 720
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

# For a machine that is already set up: each step prints "already done" and
# nothing changes. The Claude token never reaches the screen. It is removed
# from the environment while the recording is hidden, so setup cannot read it,
# and the tape types no token and no key path.
Hide
Type "unset CLAUDE_CODE_OAUTH_TOKEN"
Enter
Type "export PS1='$ ' && clear"
Enter
Show

Type "autopilot setup"
Sleep 500ms
Enter

# Each prompt takes its default. The Wait lines tie the keys to the prompts.
Wait+Screen@60s /GitHub App/
Sleep 1s
Enter
Wait+Screen@30s /App ID/
Sleep 1s
Enter
Wait+Screen@60s /Accounts, orgs/
Sleep 1s
Enter
Wait+Screen@60s /Onboard a repo now/
Sleep 1s
Type "n"
Enter

Wait+Screen@60s /Done\./
Sleep 6s
