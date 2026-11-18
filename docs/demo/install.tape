# Shared settings: keep the Output and Set lines below the same in every tape
# (install, setup, issue, status), except the Output names. Each tape repeats
# them because VHS has no include for settings.
Output docs/demo/out/install.gif
Output docs/demo/out/install.mp4

Require curl

Set Shell "bash"
Set FontSize 22
Set Width 1280
Set Height 720
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

# The install script skips a release that it already has and writes only to
# ~/.local. Render on a clean machine to show the full download.
Hide
Type "export PS1='$ ' && clear"
Enter
Show

Type "curl -fsSL https://raw.githubusercontent.com/marcaureln/autopilot/main/install.sh | sh"
Sleep 500ms
Enter
Wait+Screen@120s /==> done: autopilot/
Sleep 2s

Type "autopilot --help"
Sleep 500ms
Enter
Sleep 8s
