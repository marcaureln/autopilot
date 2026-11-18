# Shared settings: keep the Output and Set lines below the same in every tape
# (install, setup, issue, status), except the Output names. Each tape repeats
# them because VHS has no include for settings.
Output docs/demo/out/issue.gif
Output docs/demo/out/issue.mp4

Require gh
Require autopilot

Set Shell "bash"
Set FontSize 22
Set Width 1280
Set Height 720
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

# Test repo that the host watches. Replace the placeholder before you render.
Env REPO "<owner>/autopilot-sandbox"

Hide
Type "export PS1='$ ' && clear"
Enter
Show

Type `gh issue create --repo "$REPO" --title "Add a --version flag" --body "Print the version with --version. Acceptance: it prints one line and exits with code 0." --label autopilot`
Sleep 500ms
Enter
Wait+Screen@30s /github\.com/
Sleep 3s

# The host claims the issue within one poll (one minute). The wait is hidden.
Hide
Sleep 75s
Show

Type "autopilot logs --since 5m"
Sleep 500ms
Enter
Sleep 8s
